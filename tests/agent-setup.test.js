import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, chmodSync, symlinkSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { AccessRequests } from "../server/access-requests.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { connectRoom, setupTarget } from "../client/agent-setup.mjs";
import { openSetupJournal } from "../client/setup-journal.mjs";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { createAgentIdentity, redeemAgentInvite } from "../client/room-agent.mjs";
const run = promisify(execFile), secret = () => "pri_" + randomBytes(32).toString("base64url");
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "room-setup-")), store = new RoomStore(":memory:");
  for (const id of ["commons", "lab"]) store.initialize(initialRoom(id));
  const keys = Object.fromEntries(["commons", "lab"].map(id => [id, store.issueAccessKey(id, "owner")]));
  const server = createRoomServer({ store }); await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, directory = join(root, "private");
  const invite = (room = "commons") => store.invites.create(keys[room], room, { profile: "chat", displayName: "Peer" });
  const connect = extra => connectRoom({ origin, directory, name: "Peer", accept: true, ...extra });
  return { root, store, keys, origin, directory, invite, connect };
}
test("one connection survives lost registration and redemption responses with one identity and membership", async t => {
  const f = await fixture(t), invite = f.invite(); let lose = "agent-identities";
  const fetchImpl = async (url, options) => {
    const result = await fetch(url, options);
    if (new URL(url).pathname.endsWith(lose)) { lose = "never"; throw new TypeError("response lost"); }
    return result;
  };
  await assert.rejects(f.connect({ target: invite.code, fetchImpl }));
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_identities").get().n, 1);
  lose = "agent-invites/redeem";
  await assert.rejects(f.connect({ target: invite.code, fetchImpl }));
  const before = f.store.room("commons").sequence;
  const result = await f.connect({ target: invite.code, fetchImpl });
  assert.equal(result.status, "connected"); assert.equal(f.store.room("commons").sequence, before);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_identities").get().n, 1);
  const config = readAgentConnection(result.configDirectory);
  assert.equal(JSON.stringify(result).includes(config.token), false);
  assert.equal(statSync(join(f.directory, "setup.json")).mode & 0o777, 0o600);
  assert.equal(result.readiness.execution, "not_tested");
  const other = await f.connect({ target: f.invite("lab").code });
  assert.equal(other.identityId, result.identityId); assert.equal(other.roomId, "lab");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM identity_links").get().n, 2);
});
test("invite preview creates no remote identity; explicit acceptance preserves the intended grant", async t => {
  const f = await fixture(t), invite = f.invite();
  const result = await f.connect({ target: `${f.origin}/#agent-invite/${invite.code}`, accept: false });
  assert.equal(result.status, "approval_required"); assert.equal(result.preview.roomId, "commons");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_identities").get().n, 0);
  const joined = await f.connect({ target: `${f.origin}/#agent-invite/${invite.code}` });
  assert.equal(joined.roomId, "commons"); assert.deepEqual(joined.permissions, []);
});
test("independent agent discovers, requests admission once, then resumes the same identity after approval", async t => {
  const f = await fixture(t);
  const discovery = await f.connect({ target: f.origin });
  assert.equal(discovery.status, "choose_room");
  const pending = await f.connect({ target: f.origin + "/#room/commons" });
  assert.equal(pending.status, "pending");
  const repeated = await f.connect({ target: f.origin + "/#room/commons" });
  assert.equal(repeated.requestId, pending.requestId);
  new AccessRequests(f.store).decide(f.keys.commons, "commons", pending.requestId, { decision: "approve", permissions: [] });
  const connected = await f.connect({ target: f.origin + "/#room/commons" });
  assert.equal(connected.status, "connected"); assert.equal(connected.identityId, discovery.identityId);
});
test("recoverable registration cannot resurrect a revoked or rotated identity", async t => {
  const f = await fixture(t), identitySecret = secret();
  const identity = await createAgentIdentity(f.origin, "Peer", { identitySecret });
  const retry = await createAgentIdentity(f.origin, "Peer", { identitySecret });
  assert.equal(retry.identityId, identity.identityId); assert.equal(retry.duplicate, true);
  f.store.db.prepare("UPDATE agent_identities SET secret_hash=? WHERE identity_id=?").run("rotated", identity.identityId);
  await assert.rejects(createAgentIdentity(f.origin, "Peer", { identitySecret }), { code: "identity_credential_changed" });
  const revoked = secret(), next = await createAgentIdentity(f.origin, "Other", { identitySecret: revoked });
  f.store.db.prepare("UPDATE agent_identities SET revoked_at=1 WHERE identity_id=?").run(next.identityId);
  await assert.rejects(createAgentIdentity(f.origin, "Other", { identitySecret: revoked }), { code: "identity_credential_changed" });
});
test("only the redeeming identity can recover an invite; revoked membership is not reactivated", async t => {
  const f = await fixture(t), invite = f.invite(), identitySecret = secret();
  const identity = await createAgentIdentity(f.origin, "Peer", { identitySecret });
  const first = await redeemAgentInvite(f.origin, invite.code, "Peer", { identitySecret });
  const before = f.store.room("commons").sequence;
  const retry = await redeemAgentInvite(f.origin, invite.code, "Peer", { identitySecret });
  assert.equal(retry.duplicate, true); assert.equal(f.store.room("commons").sequence, before);
  await assert.rejects(redeemAgentInvite(f.origin, invite.code, "Stranger"), { code: "invite_already_used" });
  f.store.command(f.keys.commons, "commons", { id: "revoke-peer", type: "member.access_changed", data: {
    memberId: first.memberId, expectedMemberRevision: 0, permissions: [], active: false } });
  await assert.rejects(redeemAgentInvite(f.origin, invite.code, "Peer", { identitySecret }), { code: "access_ended" });
  assert.equal(f.store.room("commons").state.members[identity.identityId].active, false);
});
test("private setup ownership prevents simultaneous enrollment and unsafe files", async t => {
  const f = await fixture(t), lock = openSetupJournal(f.directory);
  await assert.rejects(f.connect({ target: f.invite().code }), /Another setup owns/); lock.close();
  const result = await f.connect({ target: f.invite().code });
  chmodSync(join(f.directory, "setup.json"), 0o644);
  await assert.rejects(f.connect({ target: f.origin + "/#room/commons" }), /private files/);
  chmodSync(join(f.directory, "setup.json"), 0o600);
  const link = join(f.root, "linked"); symlinkSync(f.directory, link);
  await assert.rejects(f.connect({ target: f.origin, directory: link }), /private files/);
  assert.equal(result.status, "connected");
});
test("CLI returns nonsecret connection and reuses a saved identity without replacing it", async t => {
  const f = await fixture(t), invite = f.invite();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ROOM_AGENT_")));
  const args = ["scripts/agent-inbox.mjs", "join", `${f.origin}/#agent-invite/${invite.code}`, f.directory, "--name", "Peer", "--accept"];
  const { stdout, stderr } = await run(process.execPath, args, { env });
  const result = JSON.parse(stdout), saved = JSON.parse(readFileSync(join(f.directory, "setup.json")));
  assert.equal(result.status, "connected"); assert.equal((stdout + stderr).includes(saved.secret), false);
  assert.equal(result.host.command, process.execPath);
  assert.equal(result.host.env.ROOM_AGENT_CONFIG, result.configDirectory);
  assert.equal(result.host.installed, false);
  const host = await openMcpTestClient(result.configDirectory);
  try {
    assert.equal(host.initialized.result.protocolVersion, "2025-11-25");
    const checked = await host.call("room_check_access"); assert.equal(checked.result.isError, undefined);
    const pack = await host.call("room_list_work"); assert.equal(pack.result.isError, undefined);
  } finally { await host.close(); }

  const other = await f.connect({ target: f.invite("lab").code, directory: join(f.root, "other"), identityFrom: result.configDirectory });
  assert.equal(other.identityId, result.identityId);
});
test("target parsing refuses human login links and cross-origin ambiguity", () => {
  assert.deepEqual(setupTarget("https://www.getdasha.com/room#room/example"), { origin: "https://www.getdasha.com", roomId: "example" });
  for (const url of ["https://example.com/#join/secret", "https://example.com/?token=x", "https://user:password@example.com/", "http://example.com/"])
    assert.throws(() => setupTarget(url));
  assert.throws(() => setupTarget("https://example.com/#room/test", "https://other.example"));
});


test("process death releases setup ownership without losing its saved identity", async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { openSetupJournal } from './client/setup-journal.mjs';
    const journal = openSetupJournal(process.argv[1]);
    journal.save({ checkpoint: 'before-request' });
    console.log('locked'); setInterval(() => journal.read(), 1000);
  `, f.directory], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  assert.throws(() => openSetupJournal(f.directory), /Another setup owns/);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const recovered = openSetupJournal(f.directory);
  assert.deepEqual(recovered.read(), { checkpoint: "before-request" }); recovered.close();
});

test("failure to save a room config preserves enrollment; retry recovers without a new grant", async t => {
  const f = await fixture(t), invite = f.invite();
  const lock = openSetupJournal(f.directory); lock.close();
  mkdirSync(join(f.directory, "rooms"), { mode: 0o700 });
  const room = join(f.directory, "rooms", "commons"); mkdirSync(room, { mode: 0o700 }); chmodSync(room, 0o500);
  await assert.rejects(f.connect({ target: invite.code }));
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM identity_links").get().n, 1);
  chmodSync(room, 0o700);
  const joined = await f.connect({ target: invite.code });
  assert.equal(joined.status, "connected");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_identities").get().n, 1);
  const another = f.invite(); await f.connect({ target: another.code });
  assert.equal(f.store.invites.preview(another.code).roomId, "commons", "an existing membership does not burn a second invite");
});

test("expired invites and denied admission remain recoverable states without enrollment duplication", async t => {
  const f = await fixture(t), invite = f.invite();
  f.store.db.prepare("UPDATE agent_invite_codes SET expires_at=0").run();
  await assert.rejects(f.connect({ target: invite.code }), { code: "invite_expired" });
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_identities").get().n, 0);
  const target = f.origin + "/#room/commons", pending = await f.connect({ target });
  new AccessRequests(f.store).decide(f.keys.commons, "commons", pending.requestId, { decision: "deny" });
  const denied = await f.connect({ target }); assert.equal(denied.status, "denied");
  assert.equal(denied.requestId, pending.requestId);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM access_requests").get().n, 1);
});
