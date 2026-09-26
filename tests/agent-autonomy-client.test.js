import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { outsideAgentBody, parseOutsideAgentBody } from "../server/outside-agents.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-autonomy-client-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const memberId of ["agent", "agent-two"]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"] } });
  }
  // Graduated autonomy tiers: the fixture agents are operator-promoted so the
  // client tests exercise them as working agents.
  for (const memberId of ["agent", "agent-two"])
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "auto-task", title: "Autonomy probe", definitionOfDone: "Claimed through the client",
    accountableMemberId: "agent", mode: "read"
  } });
  const keys = {};
  for (const memberId of ["agent", "agent-two"]) keys[memberId] = store.issueAccessKey("commons", memberId);
  // Consent-bound DMs: the client's targeted-DM test needs agent-two's approval.
  store.dmConsents.request("commons", "agent", "agent-two", "test fixture");
  store.dmConsents.decide("commons", "agent-two", "agent", "approve");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = memberId => new RoomAgentClient({ version: 1, origin, roomId: "commons", memberId, token: keys[memberId] });
  return { origin, client, keys, store };
}

test("agent client: presence, capabilities, and session claims end to end", async t => {
  const { client } = await fixture(t);
  const me = client("agent");

  // Idle at first: active roster is still present (presence honesty).
  const idle = (await me.presence()).members;
  assert.deepEqual(idle.map(m => m.memberId).sort(), ["agent", "agent-two", "owner"]);
  assert.ok(idle.every(m => m.workingOn.length === 0));

  // Advertise and read back through the registry.
  const receipt = await me.advertiseCapabilities(["web-research", " code-review ", "web-research"]);
  assert.ok(Number.isSafeInteger(receipt.sequence));
  const registry = await me.capabilities();
  const entry = registry.members.find(row => row.memberId === "agent");
  assert.deepEqual(entry.capabilities, ["web-research", "code-review"]);

  // Local validation refuses bad lists without a network call.
  assert.throws(() => me.advertiseCapabilities([]), /1 to 30/);
  assert.throws(() => me.advertiseCapabilities(["x".repeat(81)]), /1 to 80/);

  // The proposed task surfaces as a queued session card.
  const cards = await me.workSessions();
  const card = cards.sessions.find(item => item.workItemId === "auto-task");
  assert.equal(card.status, "queued");

  // Atomic claim: queued -> processing, recorded as this worker.
  const claim = await me.claimSession("auto-task");
  assert.equal(claim.duplicate, false);
  const after = (await me.workSessions({ status: "processing" })).sessions;
  assert.equal(after[0].worker_member_id, "agent");

  // A second agent driving the same session hits structural anti-collision.
  const rival = client("agent-two");
  await assert.rejects(
    rival.workSessionAction({ requestId: randomUUID(), workItemId: "auto-task",
      expectedRevision: card.revision, action: "set_status", status: "processing" }),
    error => error.code === "session_claimed");

  // Presence still lists the roster; the worker holds the claim.
  const present = (await me.presence()).members;
  assert.equal(present.length, 3);
  const worker = present.find(m => m.memberId === "agent");
  assert.equal(worker.workingOn[0].workItemId, "auto-task");

  // Claiming twice is a local no-op signal, not a server round trip.
  await assert.rejects(() => me.claimSession("auto-task"), /No queued session card/);

  // Client-side action validation.
  assert.throws(() => me.workSessionAction({ requestId: "x".repeat(43), workItemId: "auto-task",
    expectedRevision: 0, action: "delete_everything" }), /set_status or request_stop/);
});

test("agent client: say posts room messages and targeted DMs", async t => {
  const { client } = await fixture(t);
  const me = client("agent");
  const peer = client("agent-two");

  // A plain message posts and the receipt carries the journal event.
  const receipt = await me.say("Hello room, this is agent");
  assert.ok(Number.isSafeInteger(receipt.sequence));
  assert.equal(receipt.event.type, "message.posted");
  assert.equal(receipt.event.actorId, "agent");
  assert.equal(receipt.event.data.body, "Hello room, this is agent");
  assert.ok(typeof receipt.event.data.messageId === "string");

  // Another member can read it back through the thread view.
  const thread = await peer.messageThread(receipt.event.data.messageId);
  assert.ok(JSON.stringify(thread).includes("Hello room, this is agent"));

  // A targeted DM posts with toMemberId and stays private to the pair.
  const dm = await me.say("Psst, agent-two", { toMemberId: "agent-two" });
  assert.equal(dm.event.data.toMemberId, "agent-two");
  const peerThread = await peer.messageThread(dm.event.data.messageId);
  assert.ok(JSON.stringify(peerThread).includes("Psst, agent-two"));

  // Local validation refuses bad bodies without a network call.
  const longer = await me.say("x".repeat(4097));
  assert.equal(longer.event.data.body.length, 4097);
  assert.throws(() => me.say(""), /1 to 65536/);
  assert.throws(() => me.say("   "), /1 to 65536/);
  assert.throws(() => me.say("x".repeat(65537)), /1 to 65536/);
  assert.throws(() => me.say("hi", { toMemberId: "not an id!" }), /member id/);
});

test("agent client say keeps a reply under the message it answers", async t => {
  const { client } = await fixture(t);
  const me = client("agent");
  const peer = client("agent-two");
  const root = await me.say("Root for the thread");
  const reply = await peer.say("Answer in the thread", { replyToId: root.event.data.messageId });
  assert.equal(reply.event.data.replyToId, root.event.data.messageId);
  const thread = await me.messageThread(root.event.data.messageId);
  assert.ok(JSON.stringify(thread).includes("Answer in the thread"));
  assert.throws(() => peer.say("nope", { replyToId: "not an id!" }), /message id/);
});

test("agent inbox CLI exposes the autonomy primitives", async t => {
  const { origin, keys } = await fixture(t);
  const env = { ROOM_AGENT_ORIGIN: origin, ROOM_AGENT_ROOM: "commons",
    ROOM_AGENT_MEMBER: "agent", ROOM_AGENT_TOKEN: keys.agent };
  const run = async args => {
    const clean = { ...process.env };
    for (const name of Object.keys(clean)) if (name.startsWith("ROOM_AGENT_")) delete clean[name];
    try { return { ...(await promisify(execFile)(process.execPath, ["scripts/agent-inbox.mjs", ...args],
      { env: { ...clean, ...env }, encoding: "utf8", timeout: 15000 })), status: 0 }; }
    catch (error) { return { stdout: error.stdout, stderr: error.stderr, status: error.code }; }
  };
  for (const args of [["presence"], ["capabilities"], ["advertise", "web-research"], ["sessions"]]) {
    const result = await run(args);
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
    assert.ok(!result.stdout.includes(keys.agent), "CLI never echoes the token");
  }
  const claimed = await run(["claim", "auto-task"]);
  assert.equal(claimed.status, 0, claimed.stderr);
  const busy = await run(["sessions", "processing"]);
  assert.equal(busy.status, 0, busy.stderr);
  assert.ok(JSON.parse(busy.stdout).sessions.some(item => item.workItemId === "auto-task" && item.worker_member_id === "agent"));
  const moved = await run(["session", "auto-task", "active"]);
  assert.equal(moved.status, 0, moved.stderr);
  const said = await run(["say", "hello", "room", "from", "the", "cli"]);
  assert.equal(said.status, 0, said.stderr);
  const posted = JSON.parse(said.stdout);
  assert.equal(posted.event.type, "message.posted");
  assert.equal(posted.event.data.body, "hello room from the cli");
  const threaded = await run(["thread", posted.event.data.messageId]);
  assert.equal(threaded.status, 0, threaded.stderr);
  assert.ok(threaded.stdout.includes("hello room from the cli"));
  const dm = await run(["say", "--to", "agent-two", "private", "hello"]);
  assert.equal(dm.status, 0, dm.stderr);
  assert.equal(JSON.parse(dm.stdout).event.data.toMemberId, "agent-two");
  const threadedSay = await run(["say", "--reply-to", posted.event.data.messageId, "threaded", "from", "the", "cli"]);
  assert.equal(threadedSay.status, 0, threadedSay.stderr);
  assert.equal(JSON.parse(threadedSay.stdout).event.data.replyToId, posted.event.data.messageId);
  for (const args of [["say"], ["say", "--to"], ["say", "--to", "agent-two"], ["say", "--stdin", "extra"]]) {
    const result = await run(args);
    assert.notEqual(result.status, 0, `expected usage error for [${args.join(" ")}]`);
  }
});

test("agent inbox say --stdin posts an outside-agent envelope with its newline", async t => {
  const { origin, keys } = await fixture(t);
  const env = { ROOM_AGENT_ORIGIN: origin, ROOM_AGENT_ROOM: "commons",
    ROOM_AGENT_MEMBER: "agent", ROOM_AGENT_TOKEN: keys.agent };
  const envelope = 'outside-agent.v1\n{"v":1,"kind":"introduce","externalRef":"bus:stdin","displayName":"Stdin bus","origin":"bus","reach":"bus:stdin","note":null}';
  const run = (args, input) => new Promise(resolve => {
    const clean = { ...process.env };
    for (const name of Object.keys(clean)) if (name.startsWith("ROOM_AGENT_")) delete clean[name];
    const child = spawn(process.execPath, ["scripts/agent-inbox.mjs", ...args], { env: { ...clean, ...env } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => { clearTimeout(timer); resolve({ stdout, stderr, status }); });
    child.stdin.end(input ?? "");
  });
  const joined = await run(["say", "outside-agent.v1", envelope.slice("outside-agent.v1\n".length)]);
  assert.equal(joined.status, 0, joined.stderr);
  assert.equal(parseOutsideAgentBody(JSON.parse(joined.stdout).event.data.body), null);
  const posted = await run(["say", "--stdin"], envelope);
  assert.equal(posted.status, 0, posted.stderr);
  const body = JSON.parse(posted.stdout).event.data.body;
  assert.equal(body, envelope);
  assert.equal(parseOutsideAgentBody(body)?.externalRef, "bus:stdin");
  assert.equal(parseOutsideAgentBody(body)?.kind, "introduce");
});

test("a saved seat can introduce an outside agent the room can see, and a changed retry does not rewrite the card", async t => {
  const { origin, client, keys, store } = await fixture(t);
  const env = { ROOM_AGENT_ORIGIN: origin, ROOM_AGENT_ROOM: "commons",
    ROOM_AGENT_MEMBER: "agent", ROOM_AGENT_TOKEN: keys.agent };
  const run = args => new Promise(resolve => {
    const clean = { ...process.env };
    for (const name of Object.keys(clean)) if (name.startsWith("ROOM_AGENT_")) delete clean[name];
    const child = spawn(process.execPath, ["scripts/agent-inbox.mjs", ...args], { env: { ...clean, ...env } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => { clearTimeout(timer); resolve({ stdout, stderr, status }); });
    child.stdin.end();
  });
  const introduced = await run(["outside-agents", "introduce", "--ref", "bus:cli", "--name", "CLI bus", "--origin", "bus", "--reach", "bus:cli"]);
  assert.equal(introduced.status, 0, introduced.stderr);
  const posted = JSON.parse(introduced.stdout);
  assert.equal(posted.recorded, "introduce");
  assert.equal(posted.grantsAccess, false);
  const peer = client("agent-two");
  const before = await peer.snapshot();
  const network = await peer.outsideAgents();
  const card = network.agents.find(agent => agent.externalRef === "bus:cli");
  assert.equal(card?.displayName, "CLI bus");
  assert.equal(card?.introducedBy, "agent");
  assert.equal(card?.linkedMemberId, null);
  assert.equal(network.grantsAccess, false);
  assert.equal(before.state.members["bus:cli"], undefined);
  const replay = await run(["outside-agents", "introduce", "--ref", "bus:cli", "--name", "CLI bus", "--origin", "bus", "--reach", "bus:cli"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).recorded, "replay");
  const changed = await run(["outside-agents", "introduce", "--ref", "bus:cli", "--name", "CLI renamed", "--origin", "bus", "--reach", "bus:cli"]);
  assert.notEqual(changed.status, 0);
  assert.equal(JSON.parse(changed.stderr).code, "outside_agent_changed");
  const still = await peer.outsideAgents();
  assert.equal(still.agents.find(agent => agent.externalRef === "bus:cli").displayName, "CLI bus");
  assert.equal(still.evaluatedThrough, before.sequence);
  const sighting = await client("agent-two").recordOutsideAgent({
    externalRef: "bus:cli", displayName: "Seen by two", origin: "host", reach: "https://example.test/cli"
  });
  assert.equal(sighting.recorded, "sighting");
  assert.equal(sighting.grantsAccess, false);
  const confirmed = sighting.agents.find(agent => agent.externalRef === "bus:cli");
  assert.equal(confirmed.displayName, "CLI bus");
  assert.equal(confirmed.introducedBy, "agent");
  assert.deepEqual(confirmed.sightings.map(row => row.memberId), ["agent-two"]);
  assert.equal((await peer.snapshot()).state.members["bus:cli"], undefined);
  setTier(store.db, "commons", "agent", "t1_readonly");
  await assert.rejects(() => client("agent").recordOutsideAgent({
    externalRef: "bus:blocked", displayName: "Blocked", origin: "bus", reach: "bus:blocked"
  }), error => error.code === "agent_readonly" && error.status === 403);
  assert.equal((await peer.outsideAgents()).agents.find(agent => agent.externalRef === "bus:blocked"), undefined);
});

test("a saved seat can read an outside agent another member introduced, and that read grants nothing", async t => {
  const { client } = await fixture(t);
  const me = client("agent");
  const peer = client("agent-two");
  const before = await peer.snapshot();
  const beforeMembers = Object.keys(before.state.members).sort();
  await me.say(outsideAgentBody({
    v: 1, kind: "introduce", externalRef: "bus:client", displayName: "Client bus",
    origin: "bus", reach: "bus:client", note: null
  }));
  const network = await peer.outsideAgents();
  assert.equal(network.grantsAccess, false);
  const card = network.agents.find(agent => agent.externalRef === "bus:client");
  assert.equal(card?.displayName, "Client bus");
  assert.equal(card?.introducedBy, "agent");
  assert.equal(card?.linkedMemberId, null);
  const after = await peer.snapshot();
  assert.deepEqual(Object.keys(after.state.members).sort(), beforeMembers);
  assert.equal(after.state.members["bus:client"], undefined);
});

test("agent client: createAgentInvite falls back to explicit permissions when profile:collaborate is rejected", async t => {
  const calls = [];
  const oldDeployment = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.profile === "collaborate") {
      return {
        ok: false, status: 422, headers: { get: () => null },
        json: async () => ({ error: { code: "invalid_invite_scope", message: "profile must be one of: chat, contribute, review" } }),
      };
    }
    return {
      ok: true, status: 201, headers: { get: () => null },
      json: async () => ({ code: "RM-TESTCODE", inviteId: "abcdef12", roomId: "commons", permissions: body.permissions, profile: null }),
    };
  };
  const client = new RoomAgentClient({
    origin: "https://room.example", roomId: "commons",
    token: "pri_0123456789abcdef0123456789abcdef0123456789a",
    fetchImpl: oldDeployment,
  });
  const invite = await client.createAgentInvite({ profile: "collaborate", expiresInMinutes: 60, displayName: "Peer" });
  assert.equal(invite.code, "RM-TESTCODE");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { profile: "collaborate", expiresInMinutes: 60, displayName: "Peer" });
  assert.deepEqual(calls[1].permissions, ["steer", "accept_work", "complete_work", "verify"]);
  assert.ok(!("profile" in calls[1]), "fallback sends permissions, not the rejected profile");

  // A non-profile 422 still throws: the fallback only covers unknown profiles.
  const badRequest = async () => ({
    ok: false, status: 422, headers: { get: () => null },
    json: async () => ({ error: { code: "invalid_request", message: "bad ttl" } }),
  });
  const strict = new RoomAgentClient({
    origin: "https://room.example", roomId: "commons",
    token: "pri_0123456789abcdef0123456789abcdef0123456789a",
    fetchImpl: badRequest,
  });
  await assert.rejects(
    strict.createAgentInvite({ profile: "collaborate" }),
    error => error.code === "invalid_request");
});
