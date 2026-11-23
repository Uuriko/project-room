// GET /api/wake-status?roomId= gains an additive, coarse `idle` map
// (docs/IDLE-TO-USEFUL-WORK.md). Existing fields are unchanged and no
// timestamps, idle minutes, channels or URLs are served.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
const get = (origin, path, secret) => fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${secret}` } });

async function keyedAgent(f, origin, name) {
  const identity = f.store.identities.create(name);
  const scoped = await (await post(origin, "/api/agent-keys", { scopes: ["heartbeats:report", "heartbeats:read"] }, identity.secret)).json();
  return { identity, credential: scoped.credential };
}

test("room-mode wake-status adds a coarse idle state and needsOwner reason", async t => {
  const f = createAcceptanceFixture();
  const at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const live = await keyedAgent(f, origin, "idle-live-agent");
  const quiet = await keyedAgent(f, origin, "idle-quiet-agent");
  for (const [i, a] of [live, quiet].entries())
    linkWithProof(f.store, f.keys.owner, "commons", a.identity, { memberId: a.identity.identityId, displayName: `idle test ${i}`, permissions: ["write_external"] });
  await post(origin, "/api/agent-heartbeats", { hostId: "h" }, live.credential);
  await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", live.credential);

  const doc = await (await get(origin, "/api/wake-status?roomId=commons", live.credential)).json();
  // Existing fields unchanged.
  assert.equal(doc.roomId, "commons");
  assert.ok(Array.isArray(doc.wakeable) && Array.isArray(doc.notWakeable));
  assert.ok(doc.wakeable.some(e => e.agentId === live.identity.identityId));
  // Additive idle map, keyed by agentId, members only.
  assert.deepEqual(doc.idle[live.identity.identityId], { state: "idle_reachable", kind: "poller" });
  assert.deepEqual(doc.idle[quiet.identity.identityId], { state: "idle_unreachable", kind: "unknown", needsOwner: "no_live_channel" });
  for (const entry of Object.values(doc.idle)) {
    assert.deepEqual(Object.keys(entry).filter(k => !["state", "kind", "needsOwner"].includes(k)), [], "coarse fields only");
  }
  // Caller-only mode is unchanged.
  const own = await (await get(origin, "/api/wake-status", live.credential)).json();
  assert.deepEqual(Object.keys(own).sort(), ["agentId", "wakeable", "windowMs"]);
});
