// WAKE0-3a live two-party fixture: the full wake circuit over real doors.
//
// Cast: runtime A (peer) and runtime B (subject) join a locally booted
// room by invite. The operator arms loopback for wake targets
// (ROOM_WAKE_TARGET_ALLOWLIST=127.0.0.1 — deployment config, set here the
// way an operator sets it for the server process; no API call arms
// anything). B registers the bridge endpoint as its push target, wakeUrl,
// and agent.wake subscription URL, then goes dark. The bridge
// (scripts/room-listen.mjs --mode bridge, a real subprocess) is NOT
// running yet.
//
//   1. A mentions B -> exactly one wake intent, receipt reads "summoned"
//      (nothing can discharge it: no listener, bridge down).
//   2. The bridge starts (listener down). A mentions B again -> the
//      intent coalesces; the room's delivery reaches the bridge; the
//      bridge starts B's listener child; the child connects, which
//      discharges the intent; the receipt flips to "discharged".
//   3. B, awake, reads through its own door, replies echoing the nonce
//      (mention "responded"), acks its signals to zero. Wake accounting
//      reconciles: emitted 1 (coalesced), delivered >= 1.
//
// Synthetic fixture only — loopback HTTP, the repo's acceptance fixture,
// no external calls, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { listMentionReceipts } from "../server/mention-receipts.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { WAKE_TARGET_ALLOWLIST_ENV } from "../server/outbound-webhooks.mjs";

const ROOM = "commons";
const NONCE = "BRIDGE-CANARY-7f3d";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, { timeoutMs = 60_000, everyMs = 120, label = "condition", diag = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}${diag ? `; diagnostics: ${diag()}` : ""}`);
    await sleep(everyMs);
  }
}

async function call(origin, method, path, { token = null, json = null } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json !== null) headers["content-type"] = "application/json";
  const res = await fetch(`${origin}${path}`, { method, headers, body: json === null ? undefined : JSON.stringify(json) });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json: parsed, text };
}
const post = (origin, path, opts) => call(origin, "POST", path, opts);
const get = (origin, path, opts = {}) => call(origin, "GET", path, opts);

async function joinRuntime(boot, displayName, tag) {
  const { owner: ownerKey } = boot.fixture.keys;
  const invite = await post(boot.origin, `/api/rooms/${ROOM}/agent-invites`, { token: ownerKey, json: { profile: "collaborate" } });
  assert.equal(invite.status, 201, `invite create: ${invite.text?.slice(0, 200)}`);
  const redeem = await post(boot.origin, "/api/agent-invites/redeem", {
    json: { code: invite.json.code, displayName, requestId: `wake-bridge-${tag}-${randomUUID()}` },
  });
  assert.equal(redeem.status, 201, `redeem: ${redeem.text?.slice(0, 200)}`);
  const { identityId, memberId, identitySecret: agentKey } = redeem.json;
  const agent = { identityId, memberId, secret: agentKey };
  setTier(boot.store.db, ROOM, agent.memberId, "t2_standard", { updatedBy: "owner", nowMs: boot.store.now() });
  return agent;
}

async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test("WAKE0-3a fixture: intent -> bridge -> listener wakes -> receipt discharged -> reply lands", { timeout: 300_000 }, async t => {
  process.env[WAKE_TARGET_ALLOWLIST_ENV] = "127.0.0.1";
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const boot = { origin, store: fixture.store, fixture };
  let bridgeProc = null;
  t.after(async () => {
    delete process.env[WAKE_TARGET_ALLOWLIST_ENV];
    if (bridgeProc) { bridgeProc.kill("SIGTERM"); await sleep(300); bridgeProc.kill("SIGKILL"); }
    server.closeStreams?.(); server.closeAllConnections?.();
    await new Promise(resolve => server.close(() => resolve()));
    fixture.store?.close?.();
  });

  const A = await joinRuntime(boot, "Bridge Peer A", "a");
  const B = await joinRuntime(boot, "Bridge Runtime B", "b");
  const bridgePort = await freePort();
  const bridgeUrl = `http://127.0.0.1:${bridgePort}/wake`;
  // B's saved connection — the operator-side artefact the bridge's
  // listener child reads, exactly like a directly-run listener.
  const configDir = mkdtempSync(join(tmpdir(), "wake-bridge-"));
  const connectionDir = join(configDir, "private");
  saveAgentConnection(connectionDir, { version: 1, origin, roomId: ROOM, memberId: B.memberId, token: B.secret });
  t.after(() => rmSync(configDir, { recursive: true, force: true }));

  // B arms the bridge on every wake door (operator allowlist is what makes
  // these loopback registrations acceptable; the API alone never could).
  const beat = await post(origin, "/api/agent-heartbeats", { token: B.secret, json: {
    hostId: "fixture-host", mode: "wakeable", wakeUrl: bridgeUrl,
    pushNotification: { url: bridgeUrl, token: "bridge-token" },
  } });
  assert.equal(beat.status, 200, `B heartbeat with armed loopback targets: ${beat.text?.slice(0, 300)}`);
  const sub = await post(origin, "/api/agent-webhooks", { token: B.secret, json: { url: bridgeUrl, events: ["agent.wake"] } });
  assert.equal(sub.status, 201, `B wake-only subscription to the bridge: ${sub.text?.slice(0, 300)}`);

  // B goes dark; the bridge is not running anywhere yet.
  fixture.store.db.prepare("UPDATE agent_hosts SET last_seen_at = 1 WHERE agent_id = ?").run(B.identityId);

  const wakeRows = () => fixture.store.db.prepare(
    "SELECT message_id AS messageId, delivered_at AS deliveredAt FROM agent_wake_signals WHERE agent_id = ? AND kind = 'wake'").all(B.identityId);
  // Receipts key on the journal event id, not the client message id.
  const eventIdFor = messageId => fixture.store.db.prepare(
    "SELECT id FROM events WHERE room_id = ? AND json_extract(body, '$.data.messageId') = ?").get(ROOM, messageId)?.id;
  const receiptOf = messageId => listMentionReceipts(fixture.store, A.secret, ROOM).receipts
    .find(r => r.memberId === B.memberId && r.messageEventId === eventIdFor(messageId));
  const counter = event => fixture.store.db.prepare(
    "SELECT COALESCE(SUM(n),0) AS n FROM agent_wake_counters WHERE event = ? AND kind = 'wake'").get(event).n;

  const m1 = `bridge-m1-${randomUUID()}`;
  const posted1 = await post(origin, `/api/rooms/${ROOM}/commands`, { token: A.secret, json: {
    id: randomUUID(), type: "message.posted",
    data: { messageId: m1, body: `@${B.memberId} bridge fixture: if you read this, reply with the word ${NONCE}.` },
  } });
  assert.ok(posted1.status === 200 || posted1.status === 201, `A mentions B: ${posted1.text?.slice(0, 200)}`);
  assert.equal(wakeRows().length, 1, "one wake intent written for the dark runtime");
  assert.equal(wakeRows()[0].deliveredAt, null, "the intent is outstanding while B is dark");
  assert.equal(receiptOf(m1)?.wakeState, "summoned", "sender-side receipt: summoned, not yet discharged");

  // Start the bridge. Its listener must be DOWN until a ping arrives.
  let bridgeOut = "";
  const bridgeEnv = { ...process.env, ROOM_AGENT_CONFIG: connectionDir };
  for (const name of ["ROOM_AGENT_ORIGIN", "ROOM_AGENT_ROOM", "ROOM_AGENT_MEMBER", "ROOM_AGENT_TOKEN"]) delete bridgeEnv[name];
  bridgeProc = spawn(process.execPath, [join(ROOT, "scripts/room-listen.mjs"),
    "--mode", "bridge", "--host", "fixture-host", "--cadence-seconds", "30",
    "--port", String(bridgePort), "--bind", "127.0.0.1"], {
    env: bridgeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeProc.stdout.on("data", chunk => { bridgeOut += chunk; });
  bridgeProc.stderr.on("data", chunk => { bridgeOut += chunk; });
  const health = async () => (await get(`http://127.0.0.1:${bridgePort}`, "/health")).json;
  await until(async () => { try { return (await health())?.ok; } catch { return false; } },
    { label: "bridge health", diag: () => bridgeOut.slice(-400) });
  assert.equal((await health()).listenerRunning, false, "no listener before the first ping");

  // A second mention coalesces into the same intent; its delivery reaches
  // the now-listening bridge, which starts B's listener child.
  const m2 = `bridge-m2-${randomUUID()}`;
  const posted2 = await post(origin, `/api/rooms/${ROOM}/commands`, { token: A.secret, json: {
    id: randomUUID(), type: "message.posted",
    data: { messageId: m2, body: `@${B.memberId} bridge fixture follow-up (same open need).` },
  } });
  assert.ok(posted2.status === 200 || posted2.status === 201);
  assert.equal(wakeRows().length, 1, "the second mention coalesces into the one intent");
  assert.equal(wakeRows()[0].messageId, `wake:${m2}`, "the intent's cause tracks the latest trigger");

  await until(async () => (await health()).listenerRunning === true, { label: "bridge starts the listener on the ping" });
  await until(() => bridgeOut.includes("bridge_listening"), { label: "bridge announced itself" });
  await until(() => wakeRows()[0]?.deliveredAt !== null && wakeRows()[0]?.deliveredAt !== undefined,
    { label: "the woken listener's connect discharges the intent" });
  // The intent's cause tracked the latest trigger (m2), so the discharge
  // shows on m2's receipt; m1's own receipt resolves via the reply below.
  assert.equal(receiptOf(m2)?.wakeState, "discharged", "sender-side receipt: the wake landed");
  await until(() => bridgeOut.includes(m1) || bridgeOut.includes("wake:"), { label: "listener printed a wake pointer" });

  // B, awake, works through its own door: read, reply, ack.
  const needsMe = await get(origin, "/api/needs-me", { token: B.secret });
  assert.equal(needsMe.status, 200);
  assert.ok(JSON.stringify(needsMe.json).includes(m1), "needs-me names the mention");
  const reply = await post(origin, `/api/rooms/${ROOM}/commands`, { token: B.secret, json: {
    id: randomUUID(), type: "message.posted",
    data: { messageId: `bridge-reply-${randomUUID()}`, replyToId: m1,
      body: `${NONCE} — read and answered by runtime B after the bridge woke its listener.` },
  } });
  assert.ok(reply.status === 200 || reply.status === 201, `B replies: ${reply.text?.slice(0, 200)}`);
  assert.equal(receiptOf(m1)?.state, "responded", "the mention resolves as responded");

  const page = await get(origin, `/api/agent-wakes/poll?hostId=fixture-host&waitMs=0`, { token: B.secret });
  const pending = page.json?.pendingWakes ?? [];
  assert.ok(pending.length >= 2, "poll surfaces the mention signals for ack");
  const signalIds = pending.map(s => s.signalId);
  // The woken child holds the receiving lease, so a tokenless ack from
  // any other process — even B's own credential — is fenced (409), and
  // the child's renewals keep rotating its token: the ack belongs to
  // whoever holds the lease. Stop the bridge (which stops the child),
  // let the lease lapse, then B's own heartbeat acquires it and the ack
  // rides the fresh token — the production hand-off shape.
  const unfenced = await post(origin, "/api/agent-heartbeats/ack", { token: B.secret, json: { signalIds } });
  assert.equal(unfenced.status, 409, "the live listener lease fences a tokenless ack");
  bridgeProc.kill("SIGTERM");
  const leaseBeat = await until(async () => {
    const beat2 = await post(origin, "/api/agent-heartbeats", { token: B.secret, json: {
      hostId: "fixture-host", mode: "wakeable", listenerLease: { roomId: ROOM } } });
    return beat2.json?.listener?.acquired ? beat2.json.listener : false;
  }, { label: "B acquires the receiving lease after the bridge stops", timeoutMs: 120_000 });
  const ack = await post(origin, "/api/agent-heartbeats/ack", { token: B.secret, json: { signalIds, fencingToken: leaseBeat.fencingToken } });
  assert.equal(ack.status, 200, `fenced ack: ${ack.text?.slice(0, 200)}`);
  const page2 = await get(origin, `/api/agent-wakes/poll?hostId=fixture-host&waitMs=0`, { token: B.secret });
  assert.equal((page2.json?.pendingWakes ?? []).length, 0, "acks clear the queue");

  assert.equal(counter("emitted"), 1, "accounting: one intent emitted (coalesced)");
  assert.ok(counter("delivered") >= 1, "accounting: the intent's delivery is counted");
});
