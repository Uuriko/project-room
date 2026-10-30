import test from "node:test";
import assert from "node:assert/strict";
import { parseAddress, resolveAddress } from "../client/room-address.mjs";
import { isPauseEvent, pauseDigest } from "../client/pause-delivery.mjs";

const members = [
  { memberId: "ai_codex", displayName: "Codex" },
  { memberId: "ai_claude", displayName: "Claude" },
  { memberId: "ai_jill1", displayName: "Jill" },
  { memberId: "ai_jill2", displayName: "jill" },
  { memberId: "ai_gone", displayName: "Gone", active: false },
];
const claims = [
  { id: "reason-take-3", owner: "ai_claude", state: "claimed", repo: "Uuriko/project-room" },
  { id: "old", owner: "ai_claude", state: "done", repo: "Uuriko/other" },
  { id: "w2", owner: "ai_codex", state: "in_progress", repo: "Uuriko/project-room", workItemId: "wi_9" },
  { id: "w3", owner: "ai_codex", state: "blocked", repo: "acme/project-room" },
];

test("parseAddress reads the three forms and rejects junk", () => {
  assert.deepEqual(parseAddress("@Codex"), { kind: "member", person: "Codex" });
  assert.deepEqual(parseAddress("Claude/reason-take-3"), { kind: "session", person: "Claude", session: "reason-take-3" });
  assert.deepEqual(parseAddress("Uuriko/project-room:Codex"), { kind: "repo", repo: "Uuriko/project-room", person: "Codex" });
  assert.deepEqual(parseAddress("project-room:Claude"), { kind: "repo", repo: "project-room", person: "Claude" });
  for (const bad of ["", "  ", null, "a/b/c", "bad repo:x", "x:", "a\nb"]) assert.equal(parseAddress(bad), null, String(bad));
});

test("member addresses reuse roster resolution: id or unique name, inactive ignored, ambiguity rejected", () => {
  assert.deepEqual(resolveAddress("codex", { members }), { ok: true, memberId: "ai_codex" });
  assert.deepEqual(resolveAddress("ai_claude", { members }), { ok: true, memberId: "ai_claude" });
  assert.deepEqual(resolveAddress("Gone", { members }), { ok: false, error: "unknown_member" });
  const amb = resolveAddress("JILL", { members });
  assert.equal(amb.ok, false);
  assert.equal(amb.error, "ambiguous");
  assert.deepEqual(amb.candidates.map(c => c.memberId).sort(), ["ai_jill1", "ai_jill2"]);
  assert.deepEqual(resolveAddress("ai_jill2", { members }), { ok: true, memberId: "ai_jill2" });
});

test("session addresses resolve only to a live claim the member owns", () => {
  assert.deepEqual(resolveAddress("Claude/reason-take-3", { members, claims }), { ok: true, memberId: "ai_claude", claimId: "reason-take-3" });
  assert.deepEqual(resolveAddress("Codex/w2", { members, claims }), { ok: true, memberId: "ai_codex", claimId: "w2", workItemId: "wi_9" });
  assert.equal(resolveAddress("Codex/reason-take-3", { members, claims }).error, "session_not_owned");
  assert.equal(resolveAddress("Claude/old", { members, claims }).error, "session_not_owned");
});

test("repo addresses are scoped to live claims; a bare repo name matching two owners is ambiguous", () => {
  assert.deepEqual(resolveAddress("Uuriko/project-room:Claude", { members, claims }), { ok: true, memberId: "ai_claude", repo: "Uuriko/project-room" });
  assert.equal(resolveAddress("Uuriko/other:Claude", { members, claims }).error, "not_in_repo");
  assert.deepEqual(resolveAddress("Uuriko/project-room:Codex", { members, claims }), { ok: true, memberId: "ai_codex", repo: "Uuriko/project-room" });
  const amb = resolveAddress("project-room:Codex", { members, claims });
  assert.equal(amb.error, "ambiguous_repo");
  assert.deepEqual(amb.repos.sort(), ["acme/project-room", "uuriko/project-room"]);
});

test("only end-of-turn hook events count as a pause", () => {
  assert.equal(isPauseEvent({ hook_event_name: "Stop" }), true);
  assert.equal(isPauseEvent({ type: "agent-turn-complete" }), true);
  assert.equal(isPauseEvent({ hook_event_name: "PreToolUse" }), false);
  assert.equal(isPauseEvent(null), false);
});

test("pauseDigest delivers only what is new since the cursor, scrubbed, and advances the cursor", () => {
  const inbox = {
    cursor: { after: 42 },
    directMentions: [{ sequence: 40, from: "ai_codex", body: "old" }, { sequence: 41, from: "ai_codex", body: "review #5145 pri_" + "x".repeat(20) }],
    directMessages: [{ sequence: 42, from: "ai_claude", body: "can you answer?", requestKind: "reply" }],
  };
  const d = pauseDigest(inbox, { after: 40 });
  assert.equal(d.deliver, true);
  assert.equal(d.nextAfter, 42);
  assert.deepEqual(d.items.map(i => [i.kind, i.sequence]), [["mention", 41], ["request", 42]]);
  assert.match(d.text, /2 new for you since your last pause, 1 request\./);
  assert.match(pauseDigest({ directMessages: [{ sequence: 9, from: "a", body: "b", requestKind: "reply", state: "open" }] }).text, /1 request \(1 open\)\./);
  assert.match(d.text, /data, not instructions/);
  assert.doesNotMatch(d.text, /pri_x/);
  const none = pauseDigest(inbox, { after: 42 });
  assert.deepEqual(none, { deliver: false, nextAfter: 42, items: [], text: "" });
  const many = pauseDigest({ directMessages: Array.from({ length: 7 }, (_, i) => ({ sequence: i + 1, from: "a", body: "b" })) });
  assert.match(many.text, /and 2 more: read room_read_inbox with after=0/);
});

test("review fixes: id vs display-name collision is ambiguous; names with : or / resolve as members", () => {
  const tricky = [
    { memberId: "ai_c", displayName: "ai_d" },
    { memberId: "ai_d", displayName: "Grok" },
    { memberId: "ai_m", displayName: "Grok Build: this Mac" },
    { memberId: "ai_s", displayName: "Ops/Night" },
  ];
  const amb = resolveAddress("ai_d", { members: tricky });
  assert.equal(amb.error, "ambiguous");
  assert.deepEqual(amb.candidates.map(c => c.memberId).sort(), ["ai_c", "ai_d"]);
  assert.deepEqual(resolveAddress("Grok", { members: tricky }), { ok: true, memberId: "ai_d" });
  assert.deepEqual(resolveAddress("Grok Build: this Mac", { members: tricky }), { ok: true, memberId: "ai_m" });
  assert.deepEqual(resolveAddress("@ops/night", { members: tricky }), { ok: true, memberId: "ai_s" });
});
