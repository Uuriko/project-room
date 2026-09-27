// A saved room access key can already read and post. The pull script must
// use that key to register pull-only presence and surface a queued mention
// wake. It must not send a wake URL, print the credential, or acknowledge a
// signal it did not just receive.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { HEARTBEAT_STALE_AFTER_MS } from "../server/agent-heartbeats.mjs";

const script = fileURLToPath(new URL("../scripts/room-key-pull.mjs", import.meta.url));

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function runPull(origin, token, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        PATH: process.env.PATH,
        ROOM_AGENT_ORIGIN: origin,
        ROOM_AGENT_ROOM: "commons",
        ROOM_AGENT_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

test("room-key pull registers presence, returns a mention wake, and acks only that signal", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const identity = f.store.identities.create("Pull Seat");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId,
    memberId: identity.identityId,
    displayName: "Pull Seat",
    permissions: ["accept_work"],
  });
  const roomKey = f.store.issueAccessKey("commons", identity.identityId);
  const origin = await startServer(t, f);

  const first = await runPull(origin, roomKey, ["--host", "grok-home-1", "--cadence", "60"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.includes(roomKey), false);
  assert.equal(first.stderr.includes(roomKey), false);
  const registered = JSON.parse(first.stdout);
  assert.equal(registered.mode, "pull-only");
  assert.equal(registered.wakeUrl, null);
  assert.deepEqual(registered.pending, []);
  const host = f.store.agentHeartbeats.statusOf(identity.identityId).hosts[0];
  assert.equal(host.mode, "pull-only");
  assert.equal(host.wakeUrl, null);

  at += HEARTBEAT_STALE_AFTER_MS + 1000;
  f.store.command(f.keys.owner, "commons", {
    id: randomUUID(),
    type: "message.posted",
    data: { messageId: "mention-pull-seat", body: `hey @${identity.identityId} the room is waiting` },
  });

  const woken = await runPull(origin, roomKey, ["--host", "grok-home-1", "--cadence", "60"]);
  assert.equal(woken.status, 0, woken.stderr);
  const pending = JSON.parse(woken.stdout);
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.pending[0].kind, "mention");
  assert.equal(pending.pending[0].roomId, "commons");
  assert.equal(pending.pending[0].messageId, "mention-pull-seat");
  assert.equal(woken.stdout.includes(roomKey), false);

  const guessed = await runPull(origin, roomKey, ["--host", "grok-home-1", "--ack", "ws_not-from-this-pull"]);
  assert.equal(guessed.status, 2);
  assert.equal(f.store.agentHeartbeats.pendingWakes(identity.identityId).length, 1);

  const acked = await runPull(origin, roomKey, ["--host", "grok-home-1", "--ack", pending.pending[0].signalId]);
  assert.equal(acked.status, 0, acked.stderr);
  assert.deepEqual(JSON.parse(acked.stdout).acknowledged, [pending.pending[0].signalId]);
  assert.deepEqual(f.store.agentHeartbeats.pendingWakes(identity.identityId), []);
});
