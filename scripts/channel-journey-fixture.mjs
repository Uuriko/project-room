// Real local transport fixture. No external provider or pre-created result.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { connectRoom } from "../client/agent-setup.mjs";
import { readAgentConnection } from "../client/agent-connection.mjs";
export async function channelJourneyFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "human-agent-journey-")), store = new RoomStore(join(root, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner"), children = [];
  const server = createRoomServer({ store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true });
  });
  const invite = store.invites.create(ownerKey, "commons", { profile: "contribute", displayName: "Transport peer" });
  const setup = await connectRoom({ origin, directory: join(root, "private"), name: "Transport peer", accept: true, target: invite.code });
  const connection = readAgentConnection(setup.configDirectory);
  assert.match(connection.token, /^rak_/);
  return { root, store, ownerKey, server, origin, children, connection, setup, config: setup.configDirectory };
}
export function channelPeer(t, f, ordinary = false) {
  const env = { ...process.env, ROOM_AGENT_CONFIG: f.config };
  for (const name of ['ROOM_AGENT_ORIGIN', 'ROOM_AGENT_ROOM', 'ROOM_AGENT_MEMBER', 'ROOM_AGENT_TOKEN']) delete env[name];
  const child = spawn(process.execPath, [fileURLToPath(new URL(ordinary ? '../scripts/agent-mcp.mjs' : '../scripts/agent-claude-channel.mjs', import.meta.url)),
    ...(ordinary ? [] : ['--host', 'channel-test', '--cadence-seconds', '60'])], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  f.children.push(child);
  const frames = [], waiters = new Set(); let buffer = '', stderr = '', id = 0;
  const exit = once(child, 'exit');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); frames.push(frame);
      for (const waiter of [...waiters]) if (waiter.match(frame)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(frame); }
    }
  });
  const wait = match => {
    const prior = frames.find(match); if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error('Expected channel frame not received')); }, 15000) };
      waiters.add(waiter);
    });
  };
  const send = frame => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  const rpc = (method, params = {}) => { const requestId = ++id; send({ id: requestId, method, params }); return wait(frame => frame.id === requestId); };
  const initialize = () => rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-channel-peer', version: '1' } });
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); return exit; };
  t.after(async () => {
    await stop(); for (const waiter of waiters) clearTimeout(waiter.timer);
    assert.ok(!stderr.includes(f.connection.token) && !JSON.stringify(frames).includes(f.connection.token), 'No saved credential in channel output');
  });
  return { frames, child, exit, send, rpc, initialize, stop, wait, stderr: () => stderr };
}
