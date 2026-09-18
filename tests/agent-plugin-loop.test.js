// Lane D reference walkthrough: a third-party AI agent plugs into Project
// Room end-to-end, fixture-driven, no network. This is the executable
// version of the missing "reference agent example":
//
//   1. the agent reads the machine-readable plug-in manifest
//      (server/agent-plugin-manifest.mjs) and self-configures
//   2. identity mint + access request happen through the DB-backed flows
//      (tests/agent-identities.test.js, tests/access-requests.test.js) —
//      here the approved identity id is the fixture input
//   3. the agent is issued a scoped API key (server/agent-api-keys.mjs)
//   4. the agent publishes its card to the agent directory and is
//      discovered by another agent (server/agent-directory.mjs)
//   5. the two agents exchange A2A messages over an in-process bus
//      (src/a2a-transport.mjs with an injected channel)
//   6. the new agent subscribes to room events and verifies a signed
//      webhook delivery (server/agent-webhook-subscriptions.mjs)
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPluginManifest, validatePluginManifest, WELL_KNOWN_PATH,
} from "../server/agent-plugin-manifest.mjs";
import { createAgentApiKeys } from "../server/agent-api-keys.mjs";
import { createAgentDirectory } from "../server/agent-directory.mjs";
import {
  createAgentWebhookSubscriptions, verifySignature,
} from "../server/agent-webhook-subscriptions.mjs";
import { createA2ATransport } from "../src/a2a-transport.mjs";

const ORIGIN = "https://room.example";
const now = () => 1_700_000_000_000;

test("reference walkthrough: new agent plugs in end-to-end", t => {
  // --- Step 1: the agent fetches the manifest and self-configures ---
  const manifest = buildPluginManifest({ serviceOrigin: ORIGIN, roomId: "commons", clock: now });
  assert.equal(validatePluginManifest(manifest), true);
  assert.ok(manifest.enrollment.flows.some(f => f.id === "access-request"),
    "manifest names the self-serve access-request flow");
  assert.equal(manifest.directory.url, `${ORIGIN}/api/agents/directory`);
  assert.equal(WELL_KNOWN_PATH, "/.well-known/agent-plugin-manifest.json");

  // --- Step 2 (fixture): the agent minted an identity and its access
  // request was approved by the room owner (DB-backed flows, covered in
  // tests/agent-identities.test.js and tests/access-requests.test.js) ---
  const identityId = "ai_new123";

  // --- Step 3: scoped API key issued to the approved identity ---
  const keys = createAgentApiKeys({ clock: now, random: () => "reference-agent-secret-0123456789" });
  const issued = keys.issue({ identityId, scopes: ["rooms:read", "rooms:write"], label: "reference agent" });
  const authed = keys.verify(issued.secret);
  assert.ok(authed, "the issued secret authenticates");
  assert.equal(authed.identityId, identityId);
  assert.ok(keys.grants(issued.keyId, "rooms:write"));
  assert.ok(!keys.grants(issued.keyId, "mcp:exec"), "ungranted scopes deny");

  // --- Step 4: publish a card; another agent discovers it ---
  const directory = createAgentDirectory({ clock: now });
  directory.publish({
    agentId: "new-agent",
    card: {
      name: "New Agent",
      description: "A third-party reference agent.",
      url: "https://agents.example/new",
      capabilities: ["summarize"],
      skills: ["reference-loop"],
      version: "1.0.0",
    },
  });
  const publicDoc = directory.buildDocument({ serviceOrigin: ORIGIN });
  const found = publicDoc.agents.find(a => a.agentId === "new-agent");
  assert.ok(found, "another agent discovers the card in the public directory");
  assert.equal(found.cardUrl, `${ORIGIN}/api/agents/directory/new-agent`);
  assert.deepEqual([...directory.list({ capability: "summarize" }).map(a => a.agentId)], ["new-agent"]);

  // --- Step 5: A2A messaging between the new agent and an existing one ---
  const busSubs = new Set();
  const bus = {
    onInbound(cb) { busSubs.add(cb); return () => busSubs.delete(cb); },
    send(envelope) { for (const cb of [...busSubs]) cb(envelope); },
  };
  const newAgent = createA2ATransport({ channel: bus, clock: now });
  const helper = createA2ATransport({ channel: bus, clock: now });
  newAgent.connect("new-agent");
  helper.connect("helper-agent");
  const inboxNew = [], inboxHelper = [];
  newAgent.receive(env => { if (env.to === "new-agent") inboxNew.push(env); });
  helper.receive(env => { if (env.to === "helper-agent") inboxHelper.push(env); });

  newAgent.send({ from: "new-agent", to: "helper-agent", type: "message", payload: { text: "hello from the new agent" } });
  assert.equal(inboxHelper.length, 1);
  assert.equal(inboxHelper[0].payload.text, "hello from the new agent");
  helper.send({ from: "helper-agent", to: "new-agent", type: "message", payload: { text: "welcome aboard" } });
  assert.equal(inboxNew.length, 1);
  assert.equal(inboxNew[0].payload.text, "welcome aboard");
  assert.equal(inboxNew[0].from, "helper-agent");
  assert.equal(newAgent.deadLetters.length, 0);

  // --- Step 6: subscribe to room events; verify a signed delivery ---
  const subs = createAgentWebhookSubscriptions({ clock: now });
  const secret = "reference-subscription-secret-01";
  const view = subs.subscribe({
    agentId: identityId, url: "https://agents.example/new/hook",
    events: ["thread.created"], secret,
  });
  assert.equal(view.agentId, identityId);
  assert.equal(subs.match(identityId, "thread.created").length, 1);

  const delivery = subs.buildDelivery(view.subscriptionId,
    { eventType: "thread.created", data: { threadId: "t-1" } });
  assert.ok(verifySignature(secret, delivery.signature,
    { eventType: "thread.created", data: { threadId: "t-1" } }),
    "the agent verifies the HMAC signature of the inbound delivery");
  assert.ok(!verifySignature(secret, delivery.signature,
    { eventType: "thread.created", data: { threadId: "t-2" } }),
    "tampered payloads fail verification");
  subs.recordAttempt(delivery.deliveryId, { ok: true });
  const journal = subs.journal(view.subscriptionId);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].state, "delivered");
});
