// Task 21: morning digest. Pure builder tests: overnight windowing, per-channel
// grouping, sender grouping via digest-mode, triage wiring with one-tap
// actions, SLA breach annotation, and frozen outputs.
import test from "node:test";
import assert from "node:assert/strict";
import { buildMorningDigest, MorningDigestError } from "../server/morning-digest.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof MorningDigestError && error.code === code);
const DATE = "2026-09-17";
const SINCE = "2026-09-16T00:00:00.000Z";
const NOW = "2026-09-17T14:00:00.000Z";

const arrival = (overrides = {}) => ({
  id: "a1", channel: "telegram", threadId: "tg:1", senderId: "avery", senderLabel: "Avery",
  subject: "Hello", occurredAt: "2026-09-16T08:00:00.000Z", ...overrides,
});
const channelsOf = digest => Object.fromEntries(digest.channels.map(c => [c.channel, c]));

test("groups overnight arrivals by channel, then sender, busiest first", () => {
  const digest = buildMorningDigest({ arrivals: [
    arrival({ id: "a1", channel: "email", threadId: "em:1", senderId: "maya", senderLabel: "Maya", subject: "Kickoff" }),
    arrival({ id: "a2", channel: "email", threadId: "em:1", senderId: "maya", subject: "Kickoff" }),
    arrival({ id: "a3", channel: "email", threadId: "em:2", senderId: "leo", senderLabel: "Leo", subject: "Invoice" }),
    arrival({ id: "a4", channel: "telegram", threadId: "tg:1", senderId: "avery", subject: "Hello" }),
    arrival({ id: "a5", channel: "telegram", threadId: "tg:2", senderId: "avery", subject: "Again" }),
    arrival({ id: "a6", channel: "telegram", threadId: "tg:3", senderId: "zara", senderLabel: "Zara", subject: "Yo" }),
  ], since: SINCE, date: DATE, now: NOW });
  assert.equal(digest.date, DATE);
  assert.equal(digest.since, SINCE);
  assert.equal(digest.totalArrivals, 6);
  assert.deepEqual(digest.channels.map(c => c.channel), ["email", "telegram"], "busiest channel first");
  const email = channelsOf(digest).email;
  assert.equal(email.count, 3);
  assert.deepEqual(email.senderGroups.map(g => g.senderId), ["maya", "leo"], "busiest sender first");
  const maya = email.senderGroups[0];
  assert.equal(maya.threads.length, 1);
  assert.equal(maya.threads[0].newCount, 2, "two arrivals collapse into one thread row");
  assert.deepEqual(maya.threads[0].sourceIds, ["a1", "a2"]);
  assert.ok(Object.isFrozen(digest) && Object.isFrozen(digest.channels));
});

test("the since window excludes older arrivals", () => {
  const digest = buildMorningDigest({ arrivals: [
    arrival({ id: "old", occurredAt: "2026-09-15T23:59:59.000Z" }),
    arrival({ id: "new", occurredAt: SINCE }),
  ], since: SINCE, date: DATE, now: NOW });
  assert.equal(digest.totalArrivals, 1);
  assert.equal(digest.channels[0].senderGroups[0].threads[0].sourceIds[0], "new");
});

test("each thread row carries its triage decision and one-tap actions", () => {
  const digest = buildMorningDigest({ arrivals: [arrival()], since: SINCE, date: DATE, now: NOW });
  const thread = digest.channels[0].senderGroups[0].threads[0];
  assert.equal(thread.triage.action, "inbox", "no signal means plain inbox");
  assert.deepEqual(thread.actions.map(a => a.type), ["reply", "snooze", "file"]);
  assert.deepEqual(thread.actions[0].target, { threadId: "tg:1", channel: "telegram", sourceIds: ["a1"] });
});

test("needs_human becomes a handoff with a context packet, not a silent drop", () => {
  const triage = () => ({ action: "needs_human", reasons: ["uncertain wording"] });
  const digest = buildMorningDigest({ arrivals: [arrival()], since: SINCE, date: DATE, now: NOW, triage });
  const thread = digest.channels[0].senderGroups[0].threads[0];
  assert.deepEqual(thread.actions.map(a => a.type), ["handoff", "reply"]);
  const [handoff] = thread.actions;
  assert.equal(handoff.context.threadId, "tg:1");
  assert.equal(handoff.context.channel, "telegram");
  assert.deepEqual(handoff.context.reasons, ["uncertain wording"]);
  assert.deepEqual(digest.needsHuman, ["tg:1"]);
});

test("rule-driven snooze and file actions carry their detail", () => {
  const triage = arrival => arrival.senderId === "news"
    ? { action: "snooze", reasons: ["rule"], detail: "1d" }
    : { action: "file", reasons: ["rule"], detail: "receipts" };
  const digest = buildMorningDigest({ arrivals: [
    arrival({ id: "s1", threadId: "tg:n", senderId: "news", senderLabel: "News" }),
    arrival({ id: "f1", threadId: "tg:f", senderId: "bank", senderLabel: "Bank" }),
  ], since: SINCE, date: DATE, now: NOW, triage });
  const byThread = Object.fromEntries(digest.channels[0].senderGroups.flatMap(g => g.threads.map(t => [t.threadId, t])));
  assert.equal(byThread["tg:n"].actions[0].label, "Snooze 1d");
  assert.equal(byThread["tg:f"].actions[0].label, "File to receipts");
});

test("quarantine stays flag-only: listed with a review action, never hidden", () => {
  const triage = () => ({ action: "quarantine", reasons: ["spam score 90"] });
  const digest = buildMorningDigest({ arrivals: [arrival()], since: SINCE, date: DATE, now: NOW, triage });
  const thread = digest.channels[0].senderGroups[0].threads[0];
  assert.deepEqual(thread.actions.map(a => a.type), ["review"]);
  assert.deepEqual(digest.quarantined, ["tg:1"]);
  assert.equal(digest.totalArrivals, 1, "still in the brief");
});

test("SLA assessments annotate threads and surface breach lists", () => {
  const digest = buildMorningDigest({ arrivals: [
    arrival({ id: "b1", threadId: "tg:b", sla: { status: "breached", elapsedMs: 9000000, awaitingSince: "2026-09-16T06:00:00.000Z", targetMs: 7200000 } }),
    arrival({ id: "r1", threadId: "tg:r", sla: { status: "at_risk", elapsedMs: 6000000, awaitingSince: "2026-09-16T07:00:00.000Z", targetMs: 7200000 } }),
    arrival({ id: "o1", threadId: "em:o", channel: "email", sla: { status: "on_track", elapsedMs: 60000, awaitingSince: "2026-09-16T08:00:00.000Z", targetMs: 86400000 } }),
  ], since: SINCE, date: DATE, now: NOW });
  const byThread = Object.fromEntries(digest.channels.flatMap(c => c.senderGroups.flatMap(g => g.threads.map(t => [t.threadId, t]))));
  assert.equal(byThread["tg:b"].sla.status, "breached");
  assert.deepEqual(digest.breached, ["tg:b"]);
  assert.deepEqual(digest.atRisk, ["tg:r"]);
  assert.equal(byThread["em:o"].sla.status, "on_track");
});

test("default triage wires the shared decider over arrival signals", () => {
  const digest = buildMorningDigest({ arrivals: [
    arrival({ id: "spam", threadId: "tg:s", spamScore: 90 }),
    arrival({ id: "unsure", threadId: "tg:u", spamScore: 40 }),
  ], since: SINCE, date: DATE, now: NOW });
  const byThread = Object.fromEntries(digest.channels[0].senderGroups.flatMap(g => g.threads.map(t => [t.threadId, t])));
  assert.equal(byThread["tg:s"].triage.action, "quarantine");
  assert.equal(byThread["tg:u"].triage.action, "needs_human");
});

test("an unknown triage action is refused, never rendered", () => {
  throwsCode(() => buildMorningDigest({ arrivals: [arrival()], since: SINCE, date: DATE, now: NOW,
    triage: () => ({ action: "teleport", reasons: [] }) }), "invalid_digest");
});

test("malformed inputs are refused", () => {
  throwsCode(() => buildMorningDigest({ arrivals: "nope", since: SINCE, date: DATE }), "invalid_digest");
  throwsCode(() => buildMorningDigest({ arrivals: [], since: "not-a-date", date: DATE }), "invalid_digest");
  throwsCode(() => buildMorningDigest({ arrivals: [], since: SINCE, date: "09/17/2026" }), "invalid_digest");
  throwsCode(() => buildMorningDigest({ arrivals: [{ id: "x" }], since: SINCE, date: DATE }), "invalid_digest");
});
