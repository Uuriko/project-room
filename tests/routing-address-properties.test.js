// Property-style tests over the room's address routing surface: address
// parsing (server/mime-message.mjs), inbound email address routing
// (server/email-routing-inbound.mjs) and @agent mention routing
// (server/inbox-agent-routing.mjs). Generators use the same fixed-seed PRNG
// style as tests/email-envelope-property.test.js; PROPERTY_TEST_SEED shifts
// every seed for an extra exploratory run, the default stays fixed.
//
// Every test asserts an INVARIANT, not an example: parse/format round-trips,
// rejection-not-crash on garbage, and deterministic routing. A failing seed
// is a real bug in the routing logic, not a flaky test.
import test from "node:test";
import assert from "node:assert/strict";
import { routingKey, recipientCandidates, resolveRoutedConnection, lookupFromProfiles, routeInboundEmail } from "../server/email-routing-inbound.mjs";
import { parseAddressList, parseMailbox, addressPattern } from "../server/mime-message.mjs";
import { extractAgentMentions, createAgentRouter, routingStatuses, RoutingError } from "../server/inbox-agent-routing.mjs";

// ---------------------------------------------------------------- PRNG ---
const seedOffset = Number(process.env.PROPERTY_TEST_SEED ?? 0);
function rng(seed) {
  let s = (seed + seedOffset) >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = list => list[int(0, list.length - 1)];
  const chance = p => next() < p;
  return { next, int, pick, chance };
}

// ---------------------------------------------------------- generators ---
const ATOM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ATOM_LOCAL = ATOM + "._%+-";
const ATOM_DOMAIN = ATOM + "-";
const atomOf = (r, alphabet, lo, hi) => Array.from({ length: r.int(lo, hi) }, () => r.pick([...alphabet])).join("");
// Valid per the envelope's address rule, byte-capped like the real limits.
const addrSpec = r => {
  for (;;) {
    const local = atomOf(r, ATOM_LOCAL, 1, 40).replace(/^[.]+|[.]+$/g, "a");
    const domain = Array.from({ length: r.int(1, 3) }, () => atomOf(r, ATOM_DOMAIN, 1, 20).replace(/^-+|-+$/g, "a")).join(".");
    const a = `${local}@${domain}`;
    if (addressPattern.test(a) && Buffer.byteLength(a) <= 320) return a;
  }
};
const garbage = r => {
  const soup = ["<", ">", "(", ")", ",", ";", ":", "\"", "\\", "[", "]", "@", " ", "\t", "\r", "\n", "\u0000", "\u007f", "\u0080", "é", "\u{1f600}", ".", "+", "-", "*", "_", "'", "=", "?", "/", "|", "&", "%", "#", "\u200b", "\ufeff"];
  return Array.from({ length: r.int(0, 60) }, () => r.pick(soup)).join("");
};
const recase = (r, s) => Array.from(s, ch => r.chance(0.5) ? ch.toUpperCase() : ch.toLowerCase()).join("");
const agentName = r => r.pick([...ATOM]).toUpperCase().replace(/^[^A-Z]/, "A") + atomOf(r, ATOM + "_.:-", 0, 20);
const cleanLocal = s => s.replace(/[+]/g, "a"); // keep generated locals plus-free so plus-tag tests control the tag
const profile = (r, i, domains) => {
  const domain = r.pick(domains);
  const identity = { name: `P${i}`, address: `${cleanLocal(atomOf(r, ATOM_LOCAL, 3, 12)).toLowerCase()}@${domain}` };
  const aliases = Array.from({ length: r.int(0, 2) }, (_, k) => ({ name: `A${i}-${k}`, address: `${cleanLocal(atomOf(r, ATOM_LOCAL, 3, 12)).toLowerCase()}@${domain}` }));
  if (r.chance(0.35)) aliases.push({ name: `C${i}`, address: `*@${domain}` });
  return { accountId: `acct-${i}`, id: `conn-${i}`, revision: r.int(1, 9), provider: "microsoft-graph", mailboxId: `mbx-${i}`, identity, aliases };
};
const crlf = lines => lines.join("\r\n");
const rawMessage = (overrides = {}) => Buffer.from(crlf([`From: ${overrides.from ?? "Avery Quinn <avery@example.test>"}`, `To: ${overrides.to ?? "room@example.test"}`,
  `Subject: ${overrides.subject ?? "Hello"}`, "Date: Tue, 08 Sep 2026 12:00:00 +0000", `Message-ID: ${overrides.messageId ?? "<hello-1@example.test>"}`, "Content-Type: text/plain; charset=utf-8", "", overrides.body ?? "Body text.", ""]));
const routedCall = (to, raw) => routeInboundEmail({ from: "avery@example.test", to, raw, rawSize: undefined, receivedAt: "2026-09-08T12:00:05.000Z" }, { lookup: lookupFromProfiles([profile0(), profile1()]) });
const profile0 = () => ({ accountId: "a", id: "room-mail", revision: 1, provider: "microsoft-graph", mailboxId: "mbx-0",
  identity: { name: "Room", address: "room@example.test" }, aliases: [{ name: "Help", address: "help@example.test" }, { name: "Catch", address: "*@mail.example.test" }] });
const profile1 = () => ({ accountId: "a", id: "other-mail", revision: 2, provider: "microsoft-graph", mailboxId: "mbx-1",
  identity: { name: "Other", address: "other@example.test" }, aliases: [] });
const human = id => ({ kind: "human", id, label: null });

// ============================================================ routingKey ==
test("routingKey never crashes and only ever returns a valid lowercase envelope address or null", () => {
  const r = rng(0x90010001);
  for (let i = 0; i < 800; i++) {
    const input = r.chance(0.6) ? garbage(r) : r.pick([addrSpec(r), `<${addrSpec(r)}>`, `  ${addrSpec(r)}  `, recase(r, addrSpec(r)), ""]);
    let key;
    assert.doesNotThrow(() => { key = routingKey(input); }, `routingKey must not throw on ${JSON.stringify(input)}`);
    assert.ok(key === null || (typeof key === "string" && key === key.toLowerCase() && addressPattern.test(key)),
      `routingKey(${JSON.stringify(input)}) = ${JSON.stringify(key)} is not a valid lowercase address`);
  }
  for (const bad of [null, undefined, 5, {}, [], true]) assert.equal(routingKey(bad), null, `non-string ${String(bad)} must route to null`);
});

test("routingKey is case-insensitive, trims, strips one angle pair, is idempotent, and enforces the 320-byte cap", () => {
  const r = rng(0x90010002);
  for (let i = 0; i < 500; i++) {
    const a = addrSpec(r), key = routingKey(a);
    assert.ok(key, `generated address must route: ${a}`);
    assert.equal(routingKey(recase(r, a)), key, "case must not change the routing key");
    assert.equal(routingKey(` \t ${a} \r\n`), key, "surrounding whitespace must not change the routing key");
    assert.equal(routingKey(`<${a}>`), key, "one angle-bracket pair must strip");
    assert.equal(routingKey(key), key, "routingKey must be idempotent");
    const over = `${"x".repeat(300)}@${"y".repeat(30)}.test`;
    assert.equal(routingKey(over), null, "addresses over 320 bytes must not route");
  }
});

// ================================================== recipientCandidates ==
test("recipientCandidates is deterministic, exact-first / catch-all-last, and plus-addresses appear exactly when the local part carries a tag", () => {
  const r = rng(0x90010003);
  for (let i = 0; i < 500; i++) {
    const a = addrSpec(r);
    const tagged = r.chance(0.5) ? a.replace("@", `+tag${r.int(0, 99)}@`) : a;
    const first = recipientCandidates(tagged), second = recipientCandidates(tagged);
    assert.deepEqual(second, first, "candidate lists must be deterministic");
    const key = routingKey(tagged);
    if (!key) { assert.deepEqual(first, [], "unroutable input yields no candidates"); continue; }
    assert.equal(first[0].match, "exact");
    assert.equal(first[0].address, key);
    const at = key.lastIndexOf("@"), local = key.slice(0, at), domain = key.slice(at + 1), plus = local.indexOf("+");
    const last = first[first.length - 1];
    assert.deepEqual(last, { match: "catch-all", address: `*@${domain}` });
    const mid = first.slice(1, -1);
    if (plus > 0) {
      assert.equal(mid.length, 1, `exactly one plus candidate for ${key}`);
      assert.deepEqual(mid[0], { match: "plus", address: `${local.slice(0, plus)}@${domain}`, tag: local.slice(plus + 1) });
    } else assert.deepEqual(mid, [], `no plus candidate for ${key}`);
    for (const c of first) assert.ok(routingKey(c.address), `candidate ${c.address} must itself route`);
  }
  assert.deepEqual(recipientCandidates("not an address"), []);
  assert.deepEqual(recipientCandidates(""), []);
});

// ============================================ resolveRoutedConnection ==
test("resolveRoutedConnection is deterministic, honors match precedence and profile order, and never trusts a lying lookup", async () => {
  const r = rng(0x90010004);
  const domains = ["example.test", "mail.example.test", "corp.example.test"];
  for (let i = 0; i < 200; i++) {
    const profiles = [profile(r, 0, domains), profile(r, 1, domains)];
    const lookup = lookupFromProfiles(profiles);
    const owned = profiles[0].identity.address;
    for (const to of [owned, recase(r, owned), ` ${owned} `, `<${owned}>`]) {
      const a = await resolveRoutedConnection(to, lookup), b = await resolveRoutedConnection(to, lookup);
      assert.deepEqual(b, a, "resolution must be deterministic");
      assert.ok(a, `${to} must resolve`);
      assert.equal(a.match, "exact");
      assert.equal(a.tag, null);
      const listed = [a.connection.identity, ...a.connection.aliases].map(x => routingKey(x.address));
      assert.ok(listed.includes(a.address), "resolved address must be listed by the returned connection (no trust of the lookup alone)");
    }
    const plusTo = owned.replace("@", "+ticket-7@");
    const plus = await resolveRoutedConnection(plusTo, lookup);
    assert.ok(plus && plus.match === "plus", `${plusTo} must plus-resolve to the base address owner`);
    assert.equal(plus.tag, "ticket-7");
    assert.equal(plus.connection.id, profiles[0].id);
    const dupes = [profile(r, 10, domains), profile(r, 11, domains)];
    dupes[0].identity.address = "shared@example.test"; dupes[1].identity.address = "shared@example.test";
    const dupe = await resolveRoutedConnection("shared@example.test", lookupFromProfiles(dupes));
    assert.equal(dupe.connection.id, dupes[0].id, "first profile in the list wins an exact-address tie");
  }
  assert.equal(await resolveRoutedConnection("nobody here", lookupFromProfiles([profile0()])), null);
  await assert.rejects(resolveRoutedConnection("room@example.test", null), TypeError, "a non-function lookup is a contract violation");
});

// ===================================================== routeInboundEmail ==
test("routeInboundEmail never throws for malformed or unroutable input and stays deterministic for identical input", async () => {
  const r = rng(0x90010005);
  for (let i = 0; i < 120; i++) {
    const to = r.chance(0.5) ? r.pick(["room@example.test", "Room+Alpha@Example.TEST", "anyone@mail.example.test", "nobody@example.test"]) : garbage(r);
    const raw = r.chance(0.5) ? rawMessage({ body: garbage(r).slice(0, 400) }) : Buffer.from(garbage(r).slice(0, 900));
    let a, b;
    await assert.doesNotReject(async () => { a = await routedCall(to, raw); }, `routeInboundEmail must not throw for to=${JSON.stringify(to)}`);
    await assert.doesNotReject(async () => { b = await routedCall(to, raw); });
    assert.deepEqual(b, a, "identical input must route identically");
    assert.equal(typeof a.decision.accept, "boolean");
    assert.ok(a.decision.accept ? a.decision.reason === null : typeof a.decision.reason === "string");
    if (!a.decision.accept) {
      assert.equal(a.requestId, null, "rejected mail carries no idempotency key");
      assert.equal(a.envelope, null);
    } else {
      assert.match(a.requestId, /^email-routing-[a-f0-9]{64}$/);
      assert.ok(["exact", "plus", "catch-all"].includes(a.match));
    }
  }
});

test("routeInboundEmail is case/whitespace-insensitive on the envelope recipient and idempotent per Message-ID", async () => {
  const r = rng(0x90010006);
  for (let i = 0; i < 120; i++) {
    const msgId = `<prop-${i}@example.test>`;
    const raw = rawMessage({ messageId: msgId, body: `property body ${i}` });
    const a = await routedCall("room@example.test", raw);
    const b = await routedCall(recase(r, "  <Room@Example.TEST>  "), raw);
    assert.equal(a.decision.accept, true); assert.equal(b.decision.accept, true);
    assert.equal(b.connection.id, a.connection.id, "recipient casing must not change the routed connection");
    assert.equal(b.requestId, a.requestId, "idempotency key must not depend on recipient casing");
    assert.equal(b.match, "exact");
    const redelivered = await routedCall("room@example.test", rawMessage({ messageId: msgId, body: `different bytes ${i}` }));
    assert.equal(redelivered.requestId, a.requestId, "same Message-ID must reuse the idempotency key");
  }
});

// ========================================== parseAddressList/parseMailbox ==
test("parseAddressList never crashes; every entry is a valid envelope address with bounded fields", () => {
  const r = rng(0x90010007);
  for (let i = 0; i < 600; i++) {
    const value = r.chance(0.5) ? garbage(r) : Array.from({ length: r.int(1, 5) }, () =>
      r.pick([addrSpec(r), `"${r.pick(["Ann Lee", "Bob, Jr", "Eve (dev)"])}" <${addrSpec(r)}>`, `undisclosed-recipients:;`, `${addrSpec(r)} (a comment)`])).join(r.pick([", ", "; ", ","]));
    let out;
    assert.doesNotThrow(() => { out = parseAddressList(value, { max: r.int(1, 10) }); }, `parseAddressList must not throw on ${JSON.stringify(value).slice(0, 120)}`);
    assert.ok(Array.isArray(out) && out.length <= 10, "output is bounded by max");
    for (const entry of out) {
      assert.equal(typeof entry.name, "string");
      assert.ok(addressPattern.test(entry.address), `parsed address ${entry.address} must pass the envelope address rule`);
      assert.ok(Buffer.byteLength(entry.address) <= 320, "parsed address obeys the 320-byte cap");
      assert.ok(Buffer.byteLength(entry.name) <= 1024, "display name obeys the 1024-byte cap");
    }
    assert.deepEqual(parseAddressList(value), parseAddressList(value), "address parsing must be deterministic");
  }
});

test("parseAddressList round-trips valid addresses and display-name forms; parseMailbox drops junk to null", () => {
  const r = rng(0x90010008);
  for (let i = 0; i < 400; i++) {
    const a = addrSpec(r);
    assert.deepEqual(parseAddressList(a), [{ name: "", address: a }], "a bare valid address round-trips");
    assert.deepEqual(parseAddressList(`"Ann Lee" <${a}>`), [{ name: "Ann Lee", address: a }], "a display-name form keeps the address");
    assert.equal(parseAddressList(`"Ann Lee" <${a}>`)[0].address, parseAddressList(a)[0].address, "angle form and bare form resolve to the same address");
    const junk = parseMailbox(garbage(r));
    assert.ok(junk === null || (addressPattern.test(junk.address) && Buffer.byteLength(junk.address) <= 320),
      "parseMailbox drops junk to null, never to an invalid entry");
  }
  assert.equal(parseMailbox("not an address"), null);
  assert.equal(parseMailbox(""), null);
  assert.deepEqual(parseAddressList(""), []);
  assert.deepEqual(parseAddressList("undisclosed-recipients:;"), [], "a group with no mailboxes yields no entries");
});

// ============================================== extractAgentMentions ==
test("extractAgentMentions only ever returns valid, deduplicated agent names and skips email-like text", () => {
  const r = rng(0x90010009);
  const nameRe = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
  for (let i = 0; i < 500; i++) {
    const text = r.chance(0.4) ? garbage(r).slice(0, 2000) :
      Array.from({ length: r.int(1, 6) }, () => r.pick([`@${agentName(r)}`, `mail ${agentName(r).toLowerCase()}@example.test`, agentName(r), "hello", "@", "@@"])).join(" ");
    let mentions;
    assert.doesNotThrow(() => { mentions = extractAgentMentions(text); }, "mention extraction must not throw on bounded text");
    assert.ok(Object.isFrozen(mentions), "mentions are frozen");
    assert.deepEqual([...mentions], [...new Set(mentions)], "mentions are deduplicated");
    for (const m of mentions) assert.ok(nameRe.test(m), `@${m} must be a valid agent name`);
    assert.deepEqual(extractAgentMentions(text), mentions, "mention extraction must be deterministic");
  }
  const planted = agentName(r);
  assert.ok(extractAgentMentions(`hi @${planted}, take a look`).includes(planted), "a planted @mention must be found");
  assert.deepEqual(extractAgentMentions("mail bob@example.test, not @"), [], "email-like text and bare @ yield no mentions");
  for (const bad of ["x".repeat(20001), 5, null]) {
    assert.throws(() => extractAgentMentions(bad), err => err instanceof RoutingError, "only RoutingError may escape invalid input");
  }
});

// ==================================================== createAgentRouter ==
test("createAgentRouter routes one record per mention with the policy's status and never loses the agent identity", () => {
  const r = rng(0x9001000a);
  for (let i = 0; i < 200; i++) {
    const agents = Array.from({ length: r.int(1, 4) }, () => agentName(r));
    const policies = Object.fromEntries(agents.map(a => [a, r.chance(0.4)
      ? { mode: "escalate", escalateTo: human(`lead-${r.int(0, 9)}`) }
      : { mode: "direct" }]));
    let n = 0, t = 1_700_000_000_000;
    const router = createAgentRouter({ clock: () => (t += 1000), id: () => `rid-${++n}`, policy: policies });
    const text = agents.map(a => `@${a}`).join(" please ");
    const from = human("reporter-1");
    const { records, mentions } = router.route(`thread-${i}`, { text, from });
    assert.deepEqual([...mentions], agents, "mentions come back in first-appearance order");
    assert.equal(records.length, mentions.length, "exactly one record per mention");
    records.forEach((rec, k) => {
      assert.equal(rec.agent, mentions[k], "record names the mentioned agent");
      assert.equal(rec.threadId, `thread-${i}`);
      assert.deepEqual(rec.from, { kind: "human", id: "reporter-1", label: null });
      assert.ok(routingStatuses.includes(rec.status), "status is a known routing status");
      assert.equal(rec.history[0].status, rec.status, "journal opens at the routing status");
      assert.equal(rec.mode, policies[rec.agent].mode);
      if (policies[rec.agent].mode === "escalate") {
        assert.equal(rec.status, "escalated");
        assert.deepEqual(rec.escalatedTo, policies[rec.agent].escalateTo, "escalated records name the policy target");
      } else {
        assert.equal(rec.status, "routed");
        assert.equal(rec.escalatedTo, null);
      }
    });
    assert.equal(router.openCount(), records.length, "openCount tracks unresolved routings");
  }
});

test("createAgentRouter is deterministic under injected clock/id and enforces the transition graph", () => {
  const r = rng(0x9001000b);
  for (let i = 0; i < 100; i++) {
    const build = () => { let n = 0, t = 1_700_000_000_000; return createAgentRouter({ clock: () => (t += 1000), id: () => `rid-${++n}` }); };
    const agents = [`${agentName(r)}`, `${agentName(r)}`];
    const a = build().route("thread-x", { text: `@${agents[0]} and @${agents[1]}`, from: human("r1") });
    const b = build().route("thread-x", { text: `@${agents[0]} and @${agents[1]}`, from: human("r1") });
    assert.deepEqual(a, b, "identical policies and inputs must route identically");
    const router = build();
    const { records } = router.route("thread-x", { text: `@${agents[0]}`, from: human("r1") });
    const id0 = records[0].routingId;
    const escalated = router.escalate(id0, { by: human("lead-1"), reason: "needs a human eye" });
    assert.equal(escalated.status, "escalated");
    assert.equal(router.get(id0).status, "escalated", "the stored record carries the escalation, not just the returned copy");
    const resolved = router.resolve(id0, { by: human("lead-1"), outcome: "done" });
    assert.equal(resolved.status, "resolved");
    assert.equal(router.openCount(), 0);
    for (const bad of [() => router.escalate(id0, { by: human("lead-1"), reason: "x" }), () => router.resolve(id0, { by: human("lead-1"), outcome: "x" })])
      assert.throws(bad, err => err instanceof RoutingError && err.code === "routing_transition", "a resolved routing accepts no further transitions");
    assert.throws(() => router.get("nope"), err => err instanceof RoutingError && err.code === "routing_not_found");
  }
});

test("createAgentRouter surfaces only RoutingError for garbage input and routes text with no mentions to an empty record list", () => {
  const r = rng(0x9001000c);
  for (let i = 0; i < 200; i++) {
    const router = createAgentRouter();
    const empty = router.route(`t-${i}`, { text: garbage(r).slice(0, 500), from: human("r1") });
    assert.deepEqual([...empty.records].length, [...empty.mentions].length, "records and mentions always agree in count");
    assert.deepEqual([...empty.records].map(x => x.agent), [...empty.mentions], "every record names exactly the mention that spawned it");
  }
  const router = createAgentRouter();
  for (const bad of [() => router.route(null, { text: "hi", from: human("r1") }), () => router.route("t", { text: "hi @x", from: "nope" }),
    () => router.setPolicy("ok-agent", { mode: "bogus" }), () => router.list({ status: "bogus" }), () => createAgentRouter({ policy: { "ok": { mode: "escalate" } } })])
    assert.throws(bad, err => err instanceof RoutingError, "only RoutingError may escape the routing API");
});
