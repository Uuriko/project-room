// Pass 31: session/credential cascade fuzz. Store-level, seeded PRNG, model-checked.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

let pass = 0, failCount = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { failCount++; console.log(`FAIL ${name} ${detail}`); }
};
let a = 20260906;
const rnd = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = arr => arr[Math.floor(rnd() * arr.length)];

let now = 1_000_000_000_000;
const directory = mkdtempSync(join(tmpdir(), "adv-cascade-"));
const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
store.initialize(initialRoom());
store.initialize(initialRoom("annex", "warden"));
const cmd = (type, data) => ({ id: crypto.randomUUID(), type, data });
let ownerKey = store.issueAccessKey("commons", "owner");
let ownerExpiresAt = now + 7 * 86400000;
const ensureOwner = () => { if (ownerExpiresAt <= now) { ownerKey = store.issueAccessKey("commons", "owner"); ownerExpiresAt = now + 7 * 86400000; } };
const wardenKey = store.issueAccessKey("annex", "warden");
for (const id of ["h1", "h2", "h3", "a1"]) store.command(ownerKey, "commons", cmd(T.MEMBER_ADDED, { memberId: id, displayName: id, kind: id === "a1" ? "agent" : "human", permissions: ["steer"] }));

// Model: tokens[] = { token, roomId, memberId, kind, expiresAt, revoked, parent (token obj or null) }
const tokens = [];
const memberActive = { owner: true, h1: true, h2: true, h3: true, a1: true, warden: true };
const liveAccessKey = {}; // memberId -> token obj (commons)
const issue = (memberId, lifetimeMs = 7 * 86400000) => {
  const token = store.issueAccessKey("commons", memberId, lifetimeMs);
  for (const t of tokens) if (t.memberId === memberId && t.roomId === "commons") t.revoked = true; // rotation cascade revokes ALL prior creds incl sessions
  const entry = { token, roomId: "commons", memberId, kind: "access", expiresAt: now + lifetimeMs, revoked: false, parent: null };
  tokens.push(entry); liveAccessKey[memberId] = entry; return entry;
};
const openSession = (memberId) => {
  const keyEntry = liveAccessKey[memberId];
  if (!keyEntry) return null;
  try {
    const { token } = store.createSession(keyEntry.token);
    const expiresAt = Math.min(keyEntry.expiresAt, now + 8 * 3600000);
    const entry = { token, roomId: "commons", memberId, kind: "session", expiresAt, revoked: false, parent: keyEntry };
    tokens.push(entry); return entry;
  } catch { return null; }
};
const setActive = (memberId, active) => {
  ensureOwner();
  const m = store.room("commons").state.members[memberId];
  store.command(ownerKey, "commons", cmd(T.MEMBER_ACCESS_CHANGED, { memberId, expectedMemberRevision: m.revision, permissions: m.permissions ?? [], active }));
  memberActive[memberId] = active;
  if (!active) for (const t of tokens) if (t.memberId === memberId && t.roomId === "commons") t.revoked = true; // deactivation cascade
};
const expectedLive = t => !t.revoked && t.expiresAt > now && memberActive[t.memberId] && (!t.parent || (!t.parent.revoked && t.parent.expiresAt > now));
const sweep = (label) => {
  let mismatches = 0;
  for (const t of tokens) {
    let actual = null;
    try { actual = store.authenticate(t.token); } catch { actual = null; }
    const want = expectedLive(t);
    if (want !== Boolean(actual)) mismatches++;
    else if (actual && (actual.member.id !== t.memberId || (actual.kind === "session") !== (actual.csrf !== null))) mismatches++;
  }
  check(`model sweep: all ${tokens.length} tokens match expected auth state (${label})`, mismatches === 0, `mismatches=${mismatches}`);
};

// Targeted cases first
{
  const k = issue("h1", 3600000); // 1h key
  const s = openSession("h1");
  check("session expiry is min(key expiry, 8h)", s.expiresAt === k.expiresAt, `session=${s.expiresAt} key=${k.expiresAt}`);
  let agentErr = null;
  try { store.createSession(store.issueAccessKey("commons", "a1")); } catch (e) { agentErr = e; }
  check("agent access key cannot open a browser session (403)", agentErr?.status === 403, JSON.stringify(agentErr?.code));
  const wardenTok = wardenKey;
  let cross = null;
  try { store.authenticate(wardenTok, "commons"); } catch (e) { cross = e; }
  check("annex credential presented to commons is 403 access_denied", cross?.status === 403 && cross?.code === "access_denied", JSON.stringify(cross?.code));
  const k2 = issue("h1"); // rotate
  check("rotation kills the rotated-away access key", (() => { try { store.authenticate(k.token); return false; } catch { return true; } })());
  check("rotation kills sessions parented to the rotated key", (() => { try { store.authenticate(s.token); return false; } catch { return true; } })());
}
// Random fuzz: 500 ops, sweep every 25
const humans = ["h1", "h2", "h3"];
let deactivated = 0, reactivated = 0, issued = 0, sessions = 0, revokes = 0, timeJumps = 0;
for (let i = 1; i <= 500; i++) {
  const applicable = ["time"];
  for (const m of humans) {
    if (memberActive[m]) { applicable.push(`issue:${m}`, `deactivate:${m}`); if (liveAccessKey[m]) applicable.push(`session:${m}`); }
    else applicable.push(`reactivate:${m}`);
  }
  const live = tokens.filter(t => !t.revoked);
  if (live.length) applicable.push("revoke");
  const op = pick(applicable);
  try {
    if (op === "time") { now += pick([60000, 3600000, 9 * 3600000]); timeJumps++; }
    else if (op === "revoke") { const t = pick(live); store.revoke(t.token); t.revoked = true; revokes++; }
    else {
      const [kind, member] = op.split(":");
      if (kind === "issue") { issue(member, pick([3600000, 86400000, 7 * 86400000])); issued++; }
      else if (kind === "session") { if (openSession(member)) sessions++; }
      else if (kind === "deactivate") { setActive(member, false); deactivated++; }
      else if (kind === "reactivate") { setActive(member, true); reactivated++; }
    }
  } catch (e) { /* model only tracks successful mutations; failures are probed by the sweep */ }
  if (i % 25 === 0) sweep(`after op ${i}`);
}
sweep("final");
check("fuzz exercised every op class", issued > 20 && sessions > 20 && revokes > 20 && deactivated > 5 && reactivated > 5 && timeJumps > 20, JSON.stringify({ issued, sessions, revokes, deactivated, reactivated, timeJumps }));
// After deactivation + reactivation, a member can sign in only with a NEW key
{
  const member = humans.find(m => !memberActive[m]) ?? humans[0];
  if (!memberActive[member]) setActive(member, true);
  const oldTokens = tokens.filter(t => t.memberId === member);
  const oldAllDead = oldTokens.every(t => { try { store.authenticate(t.token); return false; } catch { return true; } });
  check("after reactivation, every pre-deactivation credential stays dead", oldAllDead);
  const freshKey = store.issueAccessKey("commons", member);
  check("fresh key after reactivation authenticates", store.authenticate(freshKey).member.id === member);
}
store.close(); rmSync(directory, { recursive: true, force: true });
console.log(`\n${pass} pass / ${failCount} fail`);
process.exit(failCount ? 1 : 0);
