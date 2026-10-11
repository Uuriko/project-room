// Onboarding skill done-condition: "you are not done until you have completed
// one successful poll cycle" must be CHECKABLE by the agent reading the skill.
// The poll route (GET /api/agent-wakes/poll) returns HTTP 200 with a JSON body
// carrying a `pendingWakes` array on success, and 401/403/404/422 JSON errors
// otherwise (see tests/agent-wake-poll.test.js for the route contract). The
// skill text must let the agent distinguish "empty because nothing is pending"
// (200 + pendingWakes: []) from silent failures (poll-before-register 404,
// bad-secret 401, invalid-hostId 422).
//
// Authoring gate (repo test-audit):
// 1. Contract: the onboarding skill's done-condition, read literally, accepts
//    only genuine poll successes and rejects poll errors/misconfigurations
//    (prompt-byte contract of the discovery packet).
// 2. Credible regression: a skill edit rewording the done-condition to "a poll
//    that returned, empty or not" (as shipped in #2533) silently blesses every
//    failure mode as "done".
// 3. Existing coverage misses it: agent-wake-poll.test.js pins the server's
//    statuses; agent-discovery.test.js pins text presence — neither connects
//    the skill's words to the outcomes an agent will actually see.
// 4. No production seam: real room server over loopback + the real generated
//    skill text; the acceptance reader is a literal model of the skill's
//    words, not a mock of server behavior.
//
// Synthetic fixtures only — loopback HTTP, no external calls or real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { skillMd } from "../deploy/agent-discovery.mjs";

// A literal reader of the skill's done-condition: what would an agent,
// following the text exactly, accept as "one successful poll cycle"?
function acceptanceFromSkillText(fullText) {
  const at = fullText.indexOf("Done-condition.");
  assert.notEqual(at, -1, "onboarding skill must contain a Done-condition section");
  const section = fullText.slice(at, at + 2000);
  if (/a poll that returned, empty or not/.test(section)) {
    // Legacy unverifiable criterion: ANY completed HTTP exchange counts —
    // 200, 404, 401, 422 alike. Only a transport failure does not.
    return outcome => outcome.transportOk;
  }
  if (/HTTP 200/.test(section) && /pendingWakes/.test(section)) {
    // Verifiable criterion: 200 + a JSON envelope carrying pendingWakes.
    return outcome => outcome.status === 200 && !!outcome.body && Array.isArray(outcome.body.pendingWakes);
  }
  throw new Error("done-condition text changed beyond recognition — update this test's reader model");
}

async function startServer(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return { f, origin: `http://127.0.0.1:${server.address().port}` };
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

async function keyedAgent(f, origin) {
  const identity = f.store.identities.create("done-condition-agent");
  const scoped = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:report", "heartbeats:read"] }, identity.secret)).json();
  return scoped.credential;
}

async function pollOutcome(origin, path, secret) {
  let res;
  try {
    res = await get(origin, path, secret);
  } catch {
    return { transportOk: false, status: 0, body: null };
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  return { transportOk: true, status: res.status, body };
}

test("done-condition: a healthy empty poll counts as one successful cycle", async t => {
  const { f, origin } = await startServer(t);
  const credential = await keyedAgent(f, origin);
  await post(origin, "/api/agent-heartbeats", { hostId: "h", cadenceSeconds: 300 }, credential);

  const accept = acceptanceFromSkillText(skillMd());
  const outcome = await pollOutcome(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", credential);
  assert.equal(outcome.status, 200);
  assert.deepEqual(outcome.body.pendingWakes, []);
  assert.equal(accept(outcome), true, "empty poll (nothing pending) must satisfy the done-condition");
});

test("done-condition: polling before registering must NOT count as a cycle", async t => {
  const { f, origin } = await startServer(t);
  const credential = await keyedAgent(f, origin);
  // No POST /api/agent-heartbeats: the host was never registered.

  const accept = acceptanceFromSkillText(skillMd());
  const outcome = await pollOutcome(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", credential);
  assert.equal(outcome.status, 404);
  assert.equal(accept(outcome), false,
    "404 agent_not_registered is a poll that 'returned' — the skill must not let the agent call it done");
});

test("done-condition: a poll with a bad secret must NOT count as a cycle", async t => {
  const { f, origin } = await startServer(t);
  await keyedAgent(f, origin);

  const accept = acceptanceFromSkillText(skillMd());
  const outcome = await pollOutcome(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", "bogus-secret");
  assert.equal(outcome.status, 401);
  assert.equal(accept(outcome), false,
    "401 is a poll that 'returned' — the skill must not let the agent call it done");
});

test("done-condition: a poll with an invalid hostId must NOT count as a cycle", async t => {
  const { f, origin } = await startServer(t);
  const credential = await keyedAgent(f, origin);
  await post(origin, "/api/agent-heartbeats", { hostId: "h", cadenceSeconds: 300 }, credential);

  const accept = acceptanceFromSkillText(skillMd());
  const outcome = await pollOutcome(origin, "/api/agent-wakes/poll?hostId=nope!&waitMs=0", credential);
  assert.equal(outcome.status, 422);
  assert.equal(accept(outcome), false,
    "422 invalid_wake_poll is a poll that 'returned' — the skill must not let the agent call it done");
});
