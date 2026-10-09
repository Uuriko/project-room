// tests/fuzz-13-mention-receipts.test.js
// WAVE-400 fuzz worker: hostile mention / receipt inputs. TEST-ONLY — reads
// production modules, writes no production code.
//
// Targets (read, never modified):
//   server/mention-lifecycle.mjs  — @mention parse (resolveMentionTargetsInText,
//                                     resolveMentionTarget, mentionTargetWarnings)
//   server/store.mjs trackMentions — mention record/dedupe (mention_states)
//   server/mention-receipts.mjs    — sender-facing receipt list
//   server/work-claims.mjs        — claim done/receipt idempotency (P4, weirder)
//   server/inbox-agent-routing.mjs — extractAgentMentions
//   server/squads.mjs             — parseSquadMentions
//
// Invariants under test:
//   I1 malformed mentions never crash and never misattribute: every recorded
//      target is an active, non-sender roster member whose label textually
//      matches at a valid @ site (checked by an independent verifier).
//   I2 duplicate receipts are idempotent: replaying an ack, a reply, or a
//      done never double-counts and never mutates terminal state.
//   I3 oversized mention lists are bounded (MAX_MESSAGE_BODY_CHARS gate).

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, MAX_MESSAGE_BODY_CHARS } from "../src/events.js";
import {
  MENTION_STATES, isMentionState, isTerminalMentionState, canTransitionMention,
  assertTransitionMention, effectiveMentionState, resolveMentionTarget,
  resolveMentionTargetsInText, mentionTargetWarnings, mentionInterruptGate,
} from "../server/mention-lifecycle.mjs";
import { extractAgentMentions } from "../server/inbox-agent-routing.mjs";
import { parseSquadMentions } from "../server/squads.mjs";
import {
  createWork, claimWork, updateWork, closeWork, closeWhenLive,
  ClaimError, isTerminalClaimState,
} from "../server/work-claims.mjs";

// --- Seeded RNG ------------------------------------------------------------
const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-13] seed=${SEED}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = arr => arr[Math.floor(rng() * arr.length)];
const rint = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// Hostile-input counter: every generated roster / body / name / string counts.
let inputs = 0;

// --- Hostile pools ----------------------------------------------------------
const PROTO_KEYS = ["__proto__", "constructor", "prototype", "toString",
  "hasOwnProperty", "valueOf", "__defineGetter__"];
const UNICODE_NAMES = ["café", "naïve", "Zoë", "北京", "αβγ", "пользователь",
  "müller", "Ångström", "😀bot", "🤖x"];
const RTL_BITS = ["\u200F", "\u200E", "\u061C", "\u202A", "\u202C", "\u2066", "\u2069"];
const BASE = ["alice", "bob", "claude", "grok", "quill", "fo", "tab",
  "instinct", "dot", "wake", "scout"];

function genNamePiece() {
  const r = rng();
  if (r < 0.30) return pick(BASE);
  if (r < 0.38) return pick(BASE).toUpperCase();
  if (r < 0.46) return pick(BASE) + rint(0, 9);              // prefix pairs: bob/bob2
  if (r < 0.54) return pick(UNICODE_NAMES);
  if (r < 0.60) return pick(BASE) + pick(RTL_BITS);          // bidi marks
  if (r < 0.66) return pick(PROTO_KEYS);                     // prototype-pollution keys
  if (r < 0.72) return pick(BASE) + pick([" ", "-", "_", "."]);
  if (r < 0.78) return pick(BASE) + " " + pick(BASE);        // multiword display names
  if (r < 0.84) return "x".repeat(rint(1, 200));             // very long labels
  if (r < 0.90) return pick(["a", "ab", "@", "_", " ", ".", "-", "a@b", "x_y"]);
  return pick(BASE).split("").join(pick(["\u0301", "\u0308"])); // combining marks
}

function setOwn(obj, k, v) {
  Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
}
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
const sanitize = s => String(s).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "x";

function genRoster() {
  const members = {};
  const n = rint(1, 7);
  for (let i = 0; i < n; i++) {
    const roll = rng();
    const id = roll < 0.15 ? pick(PROTO_KEYS)
      : roll < 0.25 ? "dup" + rint(0, 2)
      : "m" + i + "_" + sanitize(genNamePiece());
    const droll = rng();
    const displayName = droll < 0.22 ? "Shared Name"   // G16b duplicate-display-name path
      : droll < 0.30 ? pick(PROTO_KEYS)
      : "DN " + i + " " + genNamePiece();
    const vroll = rng();
    const value = vroll < 0.06 ? null
      : vroll < 0.09 ? "primitive-member"
      : { displayName, kind: "agent", active: rng() < 0.85 };
    setOwn(members, id, value);
  }
  const ids = Object.keys(members);
  const identityNames = {};
  for (const id of ids) if (rng() < 0.45) setOwn(identityNames, id, genNamePiece());
  if (rng() < 0.10) setOwn(identityNames, pick(PROTO_KEYS), genNamePiece());
  const sender = rng() < 0.75 && ids.length ? pick(ids) : "outsider_" + rint(0, 999);
  return { members, identityNames, sender, ids };
}

// Independent verifier: the exact label set the parser may match for `id`
// (mirrors mentionCandidates label construction, ranks dropped), then a
// from-scratch scan for a valid @ site with the documented boundary rules.
// One-directional: parser returning `id` REQUIRES a valid site; the parser
// may still return [] (self-silence, ambiguity) where a site exists.
function memberLabels(members, identityNames, id) {
  const out = [];
  if (!hasOwn(members, id)) return out;
  const member = members[id];
  [id, member?.displayName, identityNames?.[id]].forEach((name, rank) => {
    if (typeof name !== "string" || !name.trim()) return;
    out.push(name.toLowerCase());
    if (rank === 1) {
      for (const m of name.matchAll(/\s+/g)) {
        if (m.index > 0) out.push(name.slice(0, m.index).toLowerCase());
      }
    }
  });
  return out;
}

function hasValidMentionSite(members, identityNames, text, id) {
  const labels = memberLabels(members, identityNames, id);
  if (!labels.length) return false;
  const lowerText = text.toLowerCase();
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at > 0 && /[A-Za-z0-9_.@]/.test(text[at - 1])) continue; // email / qualified
    if (text[at + 1] === "_") continue;                          // silent @_mention
    const nameAt = at + 1;
    for (const lab of labels) {
      const end = nameAt + lab.length;
      if (lowerText.slice(nameAt, end) !== lab) continue;
      if (end < text.length && /[A-Za-z0-9_]/.test(text[end])) continue; // word boundary
      return true;
    }
  }
  return false;
}

function genBody(labelPool) {
  const parts = [];
  const n = rint(0, 14);
  for (let i = 0; i < n; i++) {
    const r = rng();
    if (r < 0.50) parts.push("@" + pick(labelPool));
    else if (r < 0.56) parts.push(pick(["@_silent", "@_", "@", "@@", "@ "]));
    else if (r < 0.62) parts.push(pick(["me@example.com", "a@b.co", "ping x@y now"]));
    else if (r < 0.67) parts.push("@squad/" + pick(labelPool));
    else if (r < 0.72) parts.push(pick(["\uD800", "\uDC00", "\uD800x", "�", "\uFEFF"]));
    else if (r < 0.78) parts.push(pick(labelPool)); // bare label, no @
    else if (r < 0.86) parts.push("@" + pick(labelPool) + pick([".", ",", "!", "?", ":", ";", ")", "..."]));
    else parts.push(pick(["hello", "world", "\n", "\t", "  ", "—", "…"]));
  }
  return parts.join(pick([" ", " ", "  ", ",", "\n", ""]));
}

function setupStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-fuzz13-"));
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) =>
    store.command(keys[actor], "commons", { id, type, data });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys, send, clock };
}

// --- T0: null-hostile arguments never throw -----------------------------------
test("fuzz T0: null-hostile arguments never throw", () => {
  const badMembers = [null, undefined, {}, { a: null, b: "x", c: 42, d: [] }];
  const badTexts = [null, undefined, 123, {}, [], ""];
  for (const m of badMembers) {
    for (const t of badTexts) {
      inputs += 2;
      assert.deepEqual(resolveMentionTargetsInText(m, null, t, "s"), [],
        `threw/misbehaved for members=${JSON.stringify(m)} text=${JSON.stringify(t)}`);
      assert.equal(resolveMentionTarget(m, null, t, "s"), null);
      assert.ok(Array.isArray(mentionTargetWarnings(m, null, t, "s")), "warnings not an array");
    }
  }
  for (const s of [null, undefined, 123, "__proto__", "a"]) {
    inputs++;
    assert.deepEqual(
      resolveMentionTargetsInText({ a: { displayName: "A", active: true } }, {}, "@a", s),
      s === "a" ? [] : ["a"], `hostile sender ${JSON.stringify(s)} misbehaved`);
  }
});

// --- T1: mention parse — no crash, no invention, no misattribution ----------
test("fuzz T1: resolveMentionTargetsInText never crashes, invents, or misattributes", () => {
  for (let i = 0; i < 1600; i++) {
    const { members, identityNames, sender } = genRoster(); inputs++;
    const pool = [];
    for (const id of Object.keys(members)) {
      pool.push(id, ...memberLabels(members, identityNames, id));
      const m = members[id];
      if (m && typeof m === "object" && typeof m.displayName === "string") pool.push(m.displayName);
    }
    const text = genBody(pool.length ? pool : ["nobody"]); inputs++;
    let got;
    try {
      got = resolveMentionTargetsInText(members, identityNames, text, sender);
    } catch (e) {
      assert.fail(`threw on iter ${i}: ${e?.message} body=${JSON.stringify(text).slice(0, 200)}`);
    }
    assert.ok(Array.isArray(got), "result not an array");
    assert.equal(new Set(got).size, got.length, `duplicate targets: ${JSON.stringify(got)}`);
    for (const id of got) {
      assert.ok(hasOwn(members, id), `invented recipient ${JSON.stringify(id)}`);
      assert.notEqual(id, sender, "mention resolved to the sender");
      assert.notEqual(members[id]?.active, false, "mention resolved to an inactive member");
      assert.ok(hasValidMentionSite(members, identityNames, text, id),
        `misattributed ${JSON.stringify(id)} in ${JSON.stringify(text).slice(0, 300)}`);
    }
    assert.deepEqual(
      resolveMentionTargetsInText(members, identityNames, text, sender), got, "nondeterministic parse");
  }
});

// --- T2: mention warnings consistent with delivery ---------------------------
test("fuzz T2: mentionTargetWarnings consistent with delivery", () => {
  for (let i = 0; i < 800; i++) {
    const { members, identityNames, sender } = genRoster(); inputs++;
    const pool = [...Object.keys(members)];
    const text = genBody(pool.length ? pool : ["nobody"]); inputs++;
    let warnings;
    try {
      warnings = mentionTargetWarnings(members, identityNames, text, sender);
    } catch (e) {
      assert.fail(`warnings threw on iter ${i}: ${e?.message}`);
    }
    assert.ok(Array.isArray(warnings) && Object.isFrozen(warnings), "warnings not a frozen array");
    // Active-member label set: a not_member handle must match none of these.
    const activeLabelSet = new Set();
    for (const id of Object.keys(members)) {
      const m = members[id];
      if (!m || typeof m !== "object" || m.active === false) continue;
      for (const lab of memberLabels(members, identityNames, id)) activeLabelSet.add(lab);
    }
    const seen = new Set();
    for (const w of warnings) {
      assert.ok(Object.isFrozen(w) && Object.isFrozen(w.candidates), "warning not frozen");
      assert.ok(w.reason === "ambiguous" || w.reason === "not_member", `bad reason ${w.reason}`);
      assert.ok(typeof w.handle === "string" && w.handle.length > 0, "empty handle");
      assert.ok(text.toLowerCase().includes("@" + w.handle.toLowerCase()),
        `warning handle ${JSON.stringify(w.handle)} not present in text`);
      if (w.reason === "not_member") {
        assert.ok(!activeLabelSet.has(w.handle.toLowerCase()),
          `not_member warning for a real label: ${JSON.stringify(w.handle)}`);
        assert.equal(w.candidates.length, 0, "not_member carries candidates");
      } else {
        assert.ok(w.candidates.length >= 2, "ambiguous warning with <2 candidates");
        const ids = w.candidates.map(c => c.memberId);
        assert.equal(new Set(ids).size, ids.length, "duplicate ambiguous candidates");
        for (const c of ids) {
          assert.ok(hasOwn(members, c), `ambiguous candidate not a member: ${JSON.stringify(c)}`);
          const m = members[c];
          assert.ok(m && typeof m === "object" && m.active !== false, "ambiguous candidate inactive");
          assert.ok(memberLabels(members, identityNames, c).includes(w.handle.toLowerCase()),
            `ambiguous candidate ${JSON.stringify(c)} has no such label`);
        }
      }
      const key = w.reason + ":" + w.handle.toLowerCase();
      assert.ok(!seen.has(key), `duplicate warning ${key}`);
      seen.add(key);
    }
  }
});

// --- T3: single-name resolution agrees with the text scan --------------------
test("fuzz T3: resolveMentionTarget agrees with single-handle scan", () => {
  for (let i = 0; i < 600; i++) {
    const { members, identityNames, sender } = genRoster(); inputs++;
    const name = genNamePiece(); inputs++;
    let single, scanned;
    try {
      single = resolveMentionTarget(members, identityNames, name, sender);
      scanned = resolveMentionTargetsInText(members, identityNames, "@" + name, sender);
    } catch (e) {
      assert.fail(`threw for name ${JSON.stringify(name)}: ${e?.message}`);
    }
    assert.ok(single === null || (typeof single === "string" && hasOwn(members, single)),
      `resolveMentionTarget invented ${JSON.stringify(single)}`);
    if (name.startsWith("_")) {
      // Silent @_mentions never deliver via the text scan, by design.
      assert.deepEqual(scanned, [], `silent handle delivered: ${JSON.stringify(name)}`);
    } else if (single !== null) {
      // An exact name match must scan to exactly that member.
      assert.deepEqual(scanned, [single],
        `divergence for ${JSON.stringify(name)}: single=${JSON.stringify(single)} scan=${JSON.stringify(scanned)}`);
    } else {
      // No exact match: the scan may still hit on a boundary-exempt trailing
      // character (e.g. invisible bidi marks after the label). Whatever it
      // returns must still be attributable — never a wrong member.
      for (const id of scanned) {
        assert.ok(hasValidMentionSite(members, identityNames, "@" + name, id),
          `misattributed ${JSON.stringify(id)} for ${JSON.stringify(name)}`);
      }
    }
  }
});

// --- T4: extractAgentMentions hostile strings --------------------------------
test("fuzz T4: extractAgentMentions hostile strings", () => {
  for (let i = 0; i < 600; i++) {
    const r = rng();
    let text;
    if (r < 0.30) text = genBody(["alice", "bob", "x".repeat(70), "a:b", "a-b", "a.b", "a_b"]);
    else if (r < 0.45) text = "\uD800".repeat(rint(1, 20)) + "@alice" + "\uDC00".repeat(rint(0, 5));
    else if (r < 0.55) text = "x".repeat(rint(19990, 20050));  // around the 20000 bound
    else if (r < 0.65) text = "@" + "y".repeat(rint(60, 80));  // overlong handle
    else if (r < 0.75) text = "@a ".repeat(rint(1, 3000));
    else text = genNamePiece() + "@" + genNamePiece();
    inputs++;
    let got = null, threw = null;
    try { got = extractAgentMentions(text); } catch (e) { threw = e; }
    const expectThrow = !text.isWellFormed() || text.length > 20000;
    assert.equal(threw !== null, expectThrow,
      `throw mismatch len=${text.length} wellFormed=${text.isWellFormed()}`);
    if (threw) {
      assert.equal(threw.name, "RoutingError", `raw ${threw?.constructor?.name} escaped`);
      continue;
    }
    assert.ok(Object.isFrozen(got), "result not frozen");
    assert.equal(new Set(got).size, got.length, "mentions not deduped");
    for (const m of got) {
      assert.match(m, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, `bad mention shape ${JSON.stringify(m)}`);
      assert.ok(text.includes("@" + m), `mention ${JSON.stringify(m)} not literally in text`);
    }
  }
});

// --- T5: parseSquadMentions hostile text --------------------------------------
test("fuzz T5: parseSquadMentions hostile text", () => {
  for (let i = 0; i < 600; i++) {
    const r = rng();
    let text;
    if (r < 0.50) text = genBody(["alpha", "beta", "x".repeat(70)]);
    else if (r < 0.60) text = ("@squad/" + pick(["a", "Team-1", "x_y", "Z".repeat(70), ""]) + " ").repeat(rint(1, 50));
    else if (r < 0.70) text = "@SQUAD/UpPeR @squad/mixedCase @@squad/dbl";
    else if (r < 0.80) text = "\uD800@squad/bad\uDC00";
    else text = "x".repeat(rint(65500, 65600));
    inputs++;
    let got;
    try { got = parseSquadMentions(text); }
    catch (e) { assert.fail(`threw on iter ${i}: ${e?.message}`); }
    assert.ok(Array.isArray(got), "result not an array");
    assert.equal(new Set(got).size, got.length, "squad mentions not deduped");
    const lower = text.toLowerCase();
    for (const name of got) {
      assert.match(name, /^[a-z0-9_-]{1,64}$/, `bad squad name ${JSON.stringify(name)}`);
      assert.ok(lower.includes("@squad/" + name), `squad ${JSON.stringify(name)} not in text`);
    }
    if (text.length > MAX_MESSAGE_BODY_CHARS) assert.deepEqual(got, [], "over-limit body not bounded");
  }
});

// --- T6: mention state machine transition fuzz --------------------------------
test("fuzz T6: mention state machine transitions", () => {
  const states = [...MENTION_STATES, "", "BOGUS", "delivered ", "DELIVERED",
    "__proto__", null, undefined, 42, {}];
  for (let i = 0; i < 600; i++) {
    const from = pick(states), to = pick(states); inputs++;
    const can = canTransitionMention(from, to);
    let threw = false;
    try { assertTransitionMention(from, to); } catch { threw = true; }
    assert.equal(threw, !can, `throw/can mismatch ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
    assert.equal(isMentionState(from), MENTION_STATES.includes(from), "isMentionState wrong");
    let termThrew = false;
    try { isTerminalMentionState(from); } catch { termThrew = true; }
    assert.equal(termThrew, !isMentionState(from), "isTerminalMentionState throw contract broken");
    if (isMentionState(from)) {
      const timeoutAt = pick([0, -1, 1, 999999, 1000001, NaN, Infinity, -Infinity, "x", null, undefined, 1.5]);
      inputs++;
      const eff = effectiveMentionState({ state: from, timeoutAt }, 1_000_000);
      assert.ok(isMentionState(eff), `effectiveMentionState returned ${JSON.stringify(eff)}`);
      const gate = mentionInterruptGate({
        state: from,
        explicitReRequest: rng() < 0.5,
        withinDedupeWindow: rng() < 0.5,
      });
      assert.equal(typeof gate.fire, "boolean", "gate.fire not boolean");
      assert.ok(typeof gate.reason === "string" && gate.reason.length > 0, "gate reason empty");
    } else {
      assert.throws(() => effectiveMentionState({ state: from, timeoutAt: 0 }), /unknown mention state/);
      assert.throws(() => mentionInterruptGate({ state: from }), /unknown mention state/);
    }
  }
  // Documented truth-table spot checks.
  assert.deepEqual(mentionInterruptGate({ state: "responded" }),
    { fire: false, reason: "mention already responded" });
  assert.deepEqual(mentionInterruptGate({ state: "timed_out", explicitReRequest: true }).fire, true);
  assert.deepEqual(mentionInterruptGate({ state: "timed_out" }).fire, false);
  assert.deepEqual(mentionInterruptGate({ state: "delivered", withinDedupeWindow: true }).fire, false);
  assert.deepEqual(mentionInterruptGate({ state: "delivered" }).fire, true);
});

// --- T7: oversized mention lists are bounded -----------------------------------
test("fuzz T7: oversized mention lists are bounded", () => {
  const members = {
    a: { displayName: "A", kind: "agent", active: true },
    b: { displayName: "B", kind: "agent", active: true },
  };
  const over = "x".repeat(MAX_MESSAGE_BODY_CHARS + 1);
  assert.deepEqual(resolveMentionTargetsInText(members, {}, over, "zzz"), [], "over-cap body parsed");
  assert.deepEqual(mentionTargetWarnings(members, {}, over, "zzz"), [], "over-cap body warned");
  assert.deepEqual(parseSquadMentions(over), [], "over-cap body squad-parsed");
  // 10k duplicate mentions inside the cap: must dedupe to one target, fast.
  const body10k = "@a ".repeat(10000); inputs++;
  assert.ok(body10k.length < MAX_MESSAGE_BODY_CHARS, "test body exceeds cap");
  const t0 = Date.now();
  const got = resolveMentionTargetsInText(members, {}, body10k, "zzz"); inputs++;
  const dt = Date.now() - t0;
  assert.deepEqual(got, ["a"], "10k duplicate mentions did not dedupe to one target");
  console.log(`[fuzz-13] 10k-mention body parsed in ${dt}ms`);
  assert.ok(dt < 10000, `10k mentions took ${dt}ms — amplification risk`);
  // Many distinct unknown handles: one warning each, no blowup.
  const handles = Array.from({ length: 8000 }, (_, i) => "@g" + i);
  const unknown = handles.join(" "); inputs++;
  assert.ok(unknown.length < MAX_MESSAGE_BODY_CHARS, "test body exceeds cap");
  const w = mentionTargetWarnings(members, {}, unknown, "zzz"); inputs++;
  assert.equal(w.length, 8000, "distinct unknown handles mis-warned");
  assert.ok(w.every(x => x.reason === "not_member"), "unknown handle mis-reasoned");
  const w2 = mentionTargetWarnings(members, {}, "@g0 ".repeat(5000).trim(), "zzz"); inputs++;
  assert.equal(w2.length, 1, "repeated unknown handle warned more than once");
});

// --- T8: store.trackMentions record is idempotent under replay ----------------
test("fuzz T8: store.trackMentions record is idempotent under replay", t => {
  const { store } = setupStore(t);
  const readRows = eventId => store.db.prepare(
    "SELECT mentioned_member_id AS id, state FROM mention_states WHERE room_id=? AND message_event_id=? ORDER BY mentioned_member_id"
  ).all("commons", eventId);
  for (let i = 0; i < 250; i++) {
    const { members, identityNames, sender } = genRoster(); inputs++;
    const pool = [...Object.keys(members)];
    const body = genBody(pool.length ? pool : ["nobody"]); inputs++;
    const eventId = "fuzz8-" + i + "-" + randomUUID().slice(0, 8);
    const dataRoll = rng();
    const data = dataRoll < 0.70 ? { body }
      : dataRoll < 0.80 ? { body: pick([123, null, {}, ["x"]]) }       // hostile non-string body
      : dataRoll < 0.90 ? { body, replyToId: pick([123, null, {}, "nope"]) } // hostile replyToId
      : { body, toMemberId: pick([...Object.keys(members), "ghost"]) };      // targeted DM filter
    try {
      store.trackMentions("commons", { members }, sender, data, eventId);
      store.trackMentions("commons", { members }, sender, data, eventId); // replay: same event
    } catch (e) {
      assert.fail(`trackMentions threw on iter ${i}: ${e?.message}`);
    }
    const rows = readRows(eventId);
    // DB rows must equal the pure parser (no squads / identity links in this db).
    const expected = typeof data.body === "string"
      ? resolveMentionTargetsInText(members, {}, data.body, sender)
        .filter(id => !data.toMemberId || data.toMemberId === id)
      : [];
    assert.deepEqual(rows.map(r => r.id).sort(), [...expected].sort(),
      `db rows != parser on iter ${i} body=${JSON.stringify(data.body).slice(0, 160)}`);
    for (const r of rows) assert.equal(r.state, "delivered", "row not delivered on record");
  }
});

// --- T9: ack/reply replay idempotency end-to-end -------------------------------
test("fuzz T9: ack/reply replay idempotency end-to-end", t => {
  const f = setupStore(t);
  f.send("owner", T.MEMBER_ADDED, { memberId: "alice", displayName: "Alice", kind: "human", permissions: [] });
  f.send("owner", T.MEMBER_ADDED, { memberId: "bob", displayName: "Bobby", kind: "human", permissions: [] });
  f.keys.alice = f.store.issueAccessKey("commons", "alice");
  f.keys.bob = f.store.issueAccessKey("commons", "bob");
  const rowOf = (eventId, member) => f.store.db.prepare(
    "SELECT state, decided_at AS decidedAt FROM mention_states WHERE room_id=? AND message_event_id=? AND mentioned_member_id=?"
  ).get("commons", eventId, member);
  const viewOf = (eventId, member) => f.store.db.prepare(
    "SELECT state FROM mention_states WHERE room_id=? AND message_event_id=? AND mentioned_member_id=?"
  ).get("commons", eventId, member);

  for (let i = 0; i < 100; i++) {
    inputs++;
    const tag = "t9-" + i;
    const eventId = f.send("alice", T.MESSAGE_POSTED,
      { body: `hey @bob ${tag}`, messageId: "msg-" + tag }).event.id;
    assert.equal(rowOf(eventId, "bob")?.state, "delivered", "mention not recorded");

    // Ack replay: second ack returns the identical view, no state churn.
    const v1 = f.store.acknowledgeMention(f.keys.bob, "commons", eventId, null); inputs++;
    assert.equal(v1.state, "acknowledged");
    const v2 = f.store.acknowledgeMention(f.keys.bob, "commons", eventId, null); inputs++;
    assert.deepEqual(v2, v1, "ack replay mutated the receipt");

    // Reply replay: first reply settles to responded; a second identical
    // reply must not touch the terminal row. (replyToId names the message id,
    // which here is the explicit data.messageId.)
    f.send("bob", T.MESSAGE_POSTED, { body: "on it", replyToId: "msg-" + tag }); inputs++;
    const settled = rowOf(eventId, "bob");
    assert.equal(settled?.state, "responded", "reply did not settle the mention");
    f.send("bob", T.MESSAGE_POSTED, { body: "on it again", replyToId: "msg-" + tag }); inputs++;
    const settled2 = rowOf(eventId, "bob");
    assert.deepEqual(settled2, settled, "reply replay mutated a settled receipt");

    // Ack of a settled receipt: 200, unchanged (never resurrects).
    const v3 = f.store.acknowledgeMention(f.keys.bob, "commons", eventId, null); inputs++;
    assert.equal(v3.state, "responded", "ack resurrected a settled receipt");

    // Someone else's mention: 403; unknown event: 404.
    assert.throws(() => f.store.acknowledgeMention(f.keys.alice, "commons", eventId, null),
      { status: 403, code: "mention_not_yours" }, "cross-member ack not refused");
    assert.throws(() => f.store.acknowledgeMention(f.keys.bob, "commons", "nope-" + tag, null),
      { status: 404, code: "mention_not_found" }, "unknown-event ack not 404");

    // Late reply after the lazy timeout flip: timed_out is terminal.
    const lateId = f.send("alice", T.MESSAGE_POSTED,
      { body: `@bob late ${tag}`, messageId: "late-" + tag }).event.id;
    f.clock.now += 31 * 60 * 1000;
    const flipped = f.store.flipExpiredMentions("commons");
    assert.ok(flipped >= 1, "expiry flip found nothing");
    assert.equal(rowOf(lateId, "bob")?.state, "timed_out", "row did not flip to timed_out");
    f.send("bob", T.MESSAGE_POSTED, { body: "too late", replyToId: "late-" + tag }); inputs++;
    assert.equal(rowOf(lateId, "bob")?.state, "timed_out", "late reply resurrected timed_out");
    const v4 = f.store.acknowledgeMention(f.keys.bob, "commons", lateId, null); inputs++;
    assert.equal(v4.state, "timed_out", "ack resurrected timed_out");
    assert.equal(viewOf(lateId, "bob")?.state, "timed_out", "timed_out row mutated");
    void v1; void v2; void v3; void v4;
  }
});

// --- T10: claim done/receipt idempotency (P4, weirder) -------------------------
function genTitle() {
  const r = rng();
  if (r < 0.4) return ("Fix " + pick(BASE) + " " + genNamePiece()).slice(0, 512);
  if (r < 0.6) return ("RTl \u202B" + genNamePiece() + "\u202C done").slice(0, 512);
  if (r < 0.75) return "@bob " + "x".repeat(rint(400, 500));
  if (r < 0.9) return pick(UNICODE_NAMES) + " — " + pick(PROTO_KEYS);
  return "t".repeat(512);
}
function genNote() {
  const r = rng();
  const s = r < 0.5 ? `note ${genNamePiece()} @${pick(BASE)} done`
    : r < 0.7 ? "\uD800 lone \uDC00 surrogate \uFEFF" + genNamePiece()
    : r < 0.85 ? ("n".repeat(rint(3900, 4000)))
    : `state:done spoof attempt\n${pick(PROTO_KEYS)}`;
  return s.slice(0, 4000);
}
function genTags() {
  const n = rint(0, 10);
  const tags = [];
  for (let i = 0; i < n; i++) {
    tags.push(pick(["__proto__", "constructor", "UPPER", "a", "0", "-", "_",
      "t".repeat(32), "ship-it", "v2"]));
  }
  return [...new Set(tags)];
}
function genBlobs() {
  const n = rint(0, 3);
  const hex = "0123456789abcdef";
  const blobs = [];
  for (let i = 0; i < n; i++) {
    blobs.push("sha256:" + Array.from({ length: 64 }, () => pick([...hex])).join(""));
  }
  return blobs;
}

test("fuzz T10: claim done/receipt idempotency — replayed dones never double-count", () => {
  const seenReceiptIds = new Set();
  for (let i = 0; i < 400; i++) {
    inputs++;
    const now = 1_786_000_000_000 + i * 1000;
    const id = "fz13-" + i + "-" + randomUUID().slice(0, 6);
    const agent = "agent_" + rint(0, 3);
    let item = createWork({ id, title: genTitle(), note: genNote(), tags: genTags() },
      { now, agentId: "opener" });
    item = claimWork(item, agent, { now: now + 1 });
    item = updateWork(item, agent, { state: "in_progress", now: now + 2 });
    const doneItem = updateWork(item, agent, {
      state: "done", note: genNote(),
      deliveryMode: pick(["result", "merged", "production"]),
      tags: genTags(), blobs: genBlobs(), now: now + 3,
    });
    // Exactly one state:done stamp; its `at` parses (what receiptOf reads as
    // createdAt); done is terminal; receipt payload frozen.
    const doneStamps = doneItem.history.filter(h => h.action === "state:done");
    assert.equal(doneStamps.length, 1, "done must stamp exactly once");
    assert.ok(Number.isFinite(Date.parse(doneStamps[0].at)), "done stamp `at` does not parse");
    assert.ok(isTerminalClaimState(doneItem.state), "done not terminal");
    assert.ok(Object.isFrozen(doneItem.tags) && Object.isFrozen(doneItem.blobs), "receipt payload not frozen");
    const receiptId = `rc_${doneItem.id}`;
    assert.ok(!seenReceiptIds.has(receiptId), `duplicate receiptId ${receiptId}`);
    seenReceiptIds.add(receiptId);
    // Replay attacks on the settled claim: every mutation must throw a clean
    // ClaimError and leave the item untouched.
    const snapshot = JSON.parse(JSON.stringify(doneItem));
    const replays = [
      () => updateWork(doneItem, agent, { state: "done", now: now + 4 }),
      () => updateWork(doneItem, agent, { note: "late note", now: now + 4 }),
      () => updateWork(doneItem, agent, { state: "in_progress", now: now + 4 }),
      () => closeWork(doneItem, agent, { verb: "close", reason: "again", now: now + 4 }),
      () => closeWork(doneItem, agent, { verb: "cancel", now: now + 4 }),
    ];
    for (const fn of replays) {
      inputs++;
      assert.throws(fn, ClaimError, "replay of a settled claim must throw ClaimError");
    }
    assert.deepEqual(JSON.parse(JSON.stringify(doneItem)), snapshot, "settled claim mutated by failed replay");
    // closeWhenLive must not re-stamp an already-settled land/deploy claim.
    assert.equal(closeWhenLive(doneItem, "rev-x", now + 5), null, "closeWhenLive re-stamped settled claim");
    assert.equal(doneItem.history.filter(h => h.action === "state:done").length, 1);
  }

  // closeWhenLive happy path: one stamp, then terminal.
  const land = updateWork(
    claimWork(createWork({ id: "fz13-land", title: "land it", kind: "land", revision: "rev-9" },
      { now: 1_786_000_000_000, agentId: "opener" }), "agent_0", { now: 1_786_000_000_001 }),
    "agent_0", { state: "in_progress", now: 1_786_000_000_002 });
  const settled = closeWhenLive(land, "rev-9", 1_786_000_000_003); inputs++;
  assert.ok(settled && settled.state === "done", "closeWhenLive did not settle");
  assert.equal(settled.history.filter(h => h.action === "state:done").length, 1);
  assert.equal(closeWhenLive(settled, "rev-9", 1_786_000_000_004), null, "closeWhenLive double-settled");
  assert.equal(closeWhenLive(land, "rev-other", 1_786_000_000_005), null, "closeWhenLive settled on wrong revision");

  // Hostile agent ids: clean ClaimError, never a raw TypeError.
  for (const bad of [null, 123, "", {}, []]) {
    inputs++;
    assert.throws(() => createWork({ id: "ok-" + inputs, title: "t" }, { now: 1, agentId: bad }),
      ClaimError, `agentId ${JSON.stringify(bad)} did not throw ClaimError`);
  }
  // Prototype-pollution keys are legal id strings: they must round-trip as
  // plain strings and must not pollute Object.prototype.
  const protoBefore = Object.getOwnPropertyNames(Object.prototype);
  for (const key of ["__proto__", "constructor"]) {
    inputs++;
    const item = createWork({ id: "k-" + inputs, title: "t" }, { now: 1, agentId: key });
    assert.equal(item.history[0].agentId, key, "agentId mangled");
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), protoBefore,
      "Object.prototype gained properties");
    assert.equal(typeof item.history[0].agentId, "string", "agentId not a plain string");
  }
});

// --- Summary ------------------------------------------------------------------
test("fuzz-13 summary", () => {
  console.log(`[fuzz-13] inputs=${inputs} seed=${SEED}`);
  assert.ok(inputs >= 5000, `only ${inputs} hostile inputs — need >= 5000`);
});
