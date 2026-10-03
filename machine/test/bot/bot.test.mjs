import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../../../server/store.mjs";
import { createRoomServer } from "../../../server/http.mjs";
import { initialRoom } from "../../../server/bootstrap.mjs";
import { spawnContext } from "../../lib/spawn.mjs";
import { loadConfig, saveConfig } from "../../lib/config.mjs";
import { enroll } from "../../lib/enroll.mjs";
import { mintIdentity, redeemInvite } from "../../lib/room.mjs";
import { dispatchTool } from "../../lib/tools.mjs";
import { MachineDaemon } from "../../lib/daemon.mjs";
import { MachineBot } from "../../bot/loop.mjs";
import { createRoomApi } from "../../bot/room-api.mjs";
import { botTierFromRoom } from "../../bot/config.mjs";
import { createProvider } from "../../bot/providers/index.mjs";
import { createAnthropicProvider } from "../../bot/providers/anthropic.mjs";
import { createOpenAiProvider } from "../../bot/providers/openai.mjs";
import { createDashaProvider } from "../../bot/providers/dasha.mjs";
import { createNoneProvider } from "../../bot/providers/none.mjs";
import { createLocalProvider } from "../../bot/providers/local.mjs";
import {
  ANTHROPIC_TOOL_TYPE, ANTHROPIC_URL, DASHA_URL, GUI_MESSAGE, LOCAL_TEXT_TOOLS,
  MISSING_KEY_MESSAGE, NONE_MESSAGE, OPENAI_COMPUTER_TYPE, OPENAI_URL,
  anthropicHeaders, dashaBody, localTools,
} from "../../bot/providers/schemas.mjs";
import { startFakeRelay } from "../fake-relay.mjs";

const fakes = fileURLToPath(new URL("../../fakes/", import.meta.url));
const cli = fileURLToPath(new URL("../../bin/room-machine.mjs", import.meta.url));
const MENTION = "@Room machine open Safari and send a screenshot";

function homeDir() {
  const home = mkdtempSync(join(tmpdir(), "room-bot-"));
  writeFileSync(join(home, "argv-log"), "");
  writeFileSync(join(home, "env-log"), "");
  return home;
}

function machineEnv(home, extra = {}) {
  return {
    PATH: `${fakes}:${process.env.PATH}`,
    HOME: home,
    TMPDIR: home,
    LANG: "C",
    LC_ALL: "C",
    USER: "room",
    LOGNAME: "room",
    TERM: "dumb",
    ROOM_MACHINE_ENABLED: "1",
    ROOM_MACHINE_HOME: home,
    ...extra,
  };
}

function scripted(turns, { computerUse = true } = {}) {
  let index = 0;
  return {
    name: "scripted",
    computerUse,
    async next() {
      const turn = index < turns.length ? turns[index] : { text: "Done.", actions: [] };
      index += 1;
      return {
        actions: turn.actions ?? [],
        text: turn.text ?? "",
        costUsd: turn.costUsd ?? 0,
        error: turn.error,
      };
    },
  };
}

function jsonResponse(value, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => value };
}

async function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("timed out waiting for the bot");
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-bot-server-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin, ownerKey, store, server };
}

async function post(origin, path, body, token) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function get(origin, path, token) {
  const response = await fetch(`${origin}${path}`, {
    headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function enrolled(t, { roomId = "commons" } = {}) {
  const served = await serve(t);
  const home = homeDir();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const relay = await startFakeRelay();
  t.after(() => relay.close());
  const invite = await post(served.origin, `/api/rooms/${roomId}/agent-invites`, {
    profile: "contribute", displayName: "Room machine",
  }, served.ownerKey);
  assert.equal(invite.status, 201, JSON.stringify(invite.json));
  relay.mint("bot-code", {
    machineToken: "tok-bot",
    machineId: "mac-1",
    label: "spare",
    roomId,
    ownerMemberId: "owner",
    inviteCode: invite.json.code,
    displayName: "Room machine",
    relayUrl: relay.ws,
    roomOrigin: served.origin,
  });
  const env = machineEnv(home, { ROOM_MACHINE_RELAY_URL: relay.http, ROOM_ORIGIN: served.origin });
  const result = await spawnContext.run({ env }, () => enroll({
    code: "bot-code", home, env, relayHttp: relay.http,
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return { ...served, home, env, relay, identityId: result.identityId };
}

function saveBot(home, bot) {
  const config = loadConfig(home);
  saveConfig({ ...config, bot: { enabled: true, rooms: ["commons"], tier: "t1", ...bot } }, home);
}

async function mention(room, body = MENTION, token = room.ownerKey, roomId = "commons") {
  const posted = await post(room.origin, `/api/rooms/${roomId}/commands`, {
    id: randomUUID(),
    type: "message.posted",
    data: { messageId: randomUUID(), body },
  }, token);
  assert.equal(posted.status, 201, JSON.stringify(posted.json));
  return posted.json;
}

async function step(room, bot) {
  return spawnContext.run({ env: bot.env ?? room.env }, () => bot.once());
}

function outcome(result) {
  const nested = Array.isArray(result?.results) ? result.results.at(-1) : null;
  return nested && typeof nested === "object" ? { ...result, ...nested } : result;
}

async function bodies(origin, roomId, token) {
  const page = await get(origin, `/api/rooms/${roomId}/events?after=0&limit=100`, token);
  assert.equal(page.status, 200, JSON.stringify(page.json));
  return (page.json.events ?? []).map(entry => entry.event?.data?.body).filter(body => typeof body === "string");
}

async function claims(origin, token, roomId = "commons") {
  const page = await get(origin, `/api/rooms/${roomId}/work-claims?limit=50`, token);
  assert.equal(page.status, 200, JSON.stringify(page.json));
  return page.json.claims ?? [];
}

// Observe the real transport without replacing fetch or the server handler.
function trackUpdateRequests(server) {
  const requests = [];
  server.on("request", (request, response) => {
    const path = request.url.split("?")[0];
    if (!/^\/api\/rooms\/[^/]+\/updates(?:\/|$)/.test(path)) return;
    const entry = { method: request.method, path, status: null };
    requests.push(entry);
    response.on("finish", () => { entry.status = response.statusCode; });
  });
  return requests;
}

async function listedUpdate(room, secret, messageId) {
  const listed = await get(room.origin, "/api/rooms/commons/updates?state=all", secret);
  assert.equal(listed.status, 200, JSON.stringify(listed.json));
  const item = listed.json.items.find(entry => entry.sourceRef?.messageId === messageId);
  assert.ok(item, JSON.stringify(listed.json.items));
  return { item, viewerId: listed.json.viewerId };
}

async function secretOf(room) {
  const { readSecret } = await import("../../lib/secrets.mjs");
  return spawnContext.run({ env: room.env }, () => readSecret("identity", room.home));
}

test.describe("room-machine bot", { concurrency: false }, () => {
  test("recorded provider requests match the vendor tool schemas and never leave the process", async () => {
    assert.equal(botTierFromRoom({ autonomyTier: "t2_standard" }, "t1"), "t1");
    assert.equal(botTierFromRoom({ autonomyTier: "t2_standard" }, "t3"), "t3");
    assert.equal(botTierFromRoom({ status: { autonomyTier: "t1_readonly" } }, "t3"), "t1");
    assert.equal(botTierFromRoom({ autonomyTier: "t2" }, "t1"), "t2");

    const headers = anthropicHeaders("sk-anthropic-test");
    assert.equal(Object.hasOwn(headers, "anthropic-beta"), false);
    assert.equal(headers["x-api-key"], "sk-anthropic-test");
    const seen = [];
    const anthropic = createAnthropicProvider({
      key: "sk-anthropic-test",
      model: "claude-sonnet-4-5",
      fetchImpl: async (url, init) => {
        seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
        if (seen.length === 1) {
          return jsonResponse({ content: [{ type: "tool_use", id: "toolu_1", input: { action: "screenshot" } }] });
        }
        return jsonResponse({ content: [{ type: "text", text: "done" }] });
      },
    });
    const first = await anthropic.next({ task: "open Safari", observations: [] });
    assert.equal(first.actions[0].tool, "desktop.screenshot");
    assert.equal(seen[0].url, ANTHROPIC_URL);
    assert.equal(seen[0].body.tools[0].type, ANTHROPIC_TOOL_TYPE);
    assert.equal(JSON.stringify(seen[0].body).includes("sk-anthropic-test"), false);
    const second = await anthropic.next({
      task: "open Safari",
      observations: [{ id: "toolu_1", tool: "desktop.screenshot", result: { ok: true } }],
    });
    assert.equal(second.actions.length, 0);
    assert.equal(seen[1].body.messages.at(-1).content[0].type, "tool_result");

    const openaiSeen = [];
    const openai = createOpenAiProvider({
      key: "sk-openai-test",
      model: "gpt-5.4",
      fetchImpl: async (url, init) => {
        openaiSeen.push({ url, body: JSON.parse(init.body) });
        if (openaiSeen.length === 1) {
          return jsonResponse({
            id: "resp_1",
            output: [{ type: "computer_call", call_id: "call_1", actions: [{ type: "screenshot" }] }],
          });
        }
        return jsonResponse({ id: "resp_2", output: [{ type: "message", content: [{ text: "done" }] }] });
      },
    });
    const shot = await openai.next({ task: "open Safari", observations: [] });
    assert.equal(shot.actions[0].tool, "desktop.screenshot");
    assert.equal(openaiSeen[0].url, OPENAI_URL);
    assert.equal(openaiSeen[0].body.tools[0].type, OPENAI_COMPUTER_TYPE);
    assert.equal(openaiSeen[0].body.tools[0].environment, "mac");
    assert.equal(JSON.stringify(openaiSeen[0].body).includes("sk-openai-test"), false);
    await openai.next({
      task: "open Safari",
      observations: [{ callId: "call_1", tool: "desktop.screenshot", image: "data:image/png;base64,a", result: {} }],
    });
    assert.equal(openaiSeen[1].body.input[0].type, "computer_call_output");
    assert.equal(openaiSeen[1].body.previous_response_id, "resp_1");

    assert.deepEqual(localTools({ vision: false }).map(tool => tool.function.name), [...LOCAL_TEXT_TOOLS]);
    assert.equal(localTools({ vision: true }).some(tool => tool.function.name === "screenshot"), true);
    const localSeen = [];
    const local = createLocalProvider({
      model: "llama3",
      vision: false,
      fetchImpl: async (_url, init) => {
        localSeen.push(JSON.parse(init.body));
        return jsonResponse({ message: { content: "ran ls" } });
      },
    });
    await local.next({ task: "list files", observations: [] });
    assert.deepEqual(localSeen[0].tools.map(tool => tool.function.name), [...LOCAL_TEXT_TOOLS]);

    const dasha = dashaBody({ model: "room-bot", messages: [{ role: "user", content: "hi" }] });
    assert.equal(Object.hasOwn(dasha, "tools"), false);
    const dashaCalls = [];
    const dashaProvider = createDashaProvider({
      key: "sk-dasha-test",
      model: "room-bot",
      fetchImpl: async (url, init) => {
        dashaCalls.push({ url, body: JSON.parse(init.body) });
        return jsonResponse({ choices: [{ message: { content: "text only" } }] });
      },
    });
    const dashaTurn = await dashaProvider.next({ task: "hello", observations: [] });
    assert.equal(dashaProvider.computerUse, false);
    assert.deepEqual(dashaTurn.actions, []);
    assert.equal(dashaCalls[0].url, DASHA_URL);
    assert.equal(JSON.stringify(dashaCalls[0].body).includes("sk-dasha-test"), false);

    assert.equal(createNoneProvider().message, NONE_MESSAGE);
    let fetched = false;
    const missing = await createProvider({
      name: "anthropic",
      key: null,
      fetchImpl: () => { fetched = true; return jsonResponse({}); },
    });
    assert.equal(missing.message, MISSING_KEY_MESSAGE);
    assert.equal(fetched, false);
  });

  test("bot enable stays off until a room is named, and status does not print a key", () => {
    const home = homeDir();
    try {
      const env = machineEnv(home);
      const before = spawnSync(process.execPath, [cli, "status"], { env, encoding: "utf8" });
      assert.equal(before.status, 0, before.stderr);
      assert.equal(JSON.parse(before.stdout).bot.enabled, false);
      const missing = spawnSync(process.execPath, [cli, "bot", "enable"], { env, encoding: "utf8" });
      assert.notEqual(missing.status, 0);
      const enabled = spawnSync(process.execPath, [cli, "bot", "enable", "--room", "commons", "--go", "member-2"], { env, encoding: "utf8" });
      assert.equal(enabled.status, 0, enabled.stderr);
      const turnedOn = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).bot;
      assert.equal(turnedOn.enabled, true);
      assert.deepEqual(turnedOn.rooms, ["commons"]);
      assert.deepEqual(turnedOn.goMembers, ["member-2"]);
      const disabled = spawnSync(process.execPath, [cli, "bot", "disable"], { env, encoding: "utf8" });
      assert.equal(disabled.status, 0, disabled.stderr);
      assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).bot.enabled, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a disabled bot leaves a mention wake unacked", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { enabled: false });
    await mention(room);
    const bot = new MachineBot({ home: room.home, env: room.env, waitMs: 0 });
    const result = await step(room, bot);
    assert.equal(result.enabled, false);
    const secret = await secretOf(room);
    const polled = await get(room.origin, "/api/agent-wakes/poll?hostId=room-machine&waitMs=0", secret);
    assert.equal(polled.status, 200, JSON.stringify(polled.json));
    assert.equal(polled.json.pendingWakes.length >= 1, true);
    const said = await bodies(room.origin, "commons", secret);
    assert.equal(said.some(body => body.startsWith("Plan:")), false);
  });

  test("at t1 a mention posts a plan, a stranger go is ignored, and the owner's go runs the loop to done", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { tier: "t1" });
    const secret = await secretOf(room);
    const strangerInvite = await post(room.origin, "/api/rooms/commons/agent-invites", {
      profile: "chat", displayName: "Other member",
    }, room.ownerKey);
    assert.equal(strangerInvite.status, 201, JSON.stringify(strangerInvite.json));
    const minted = await mintIdentity(room.origin, "Other member");
    assert.equal(minted.ok, true, JSON.stringify(minted));
    const redeemed = await redeemInvite(room.origin, {
      code: strangerInvite.json.code, displayName: "Other member", secret: minted.secret,
    });
    assert.equal(redeemed.ok, true, JSON.stringify(redeemed));

    await mention(room);
    const bot = new MachineBot({
      home: room.home,
      env: room.env,
      waitMs: 0,
      provider: scripted([
        { actions: [{ tool: "desktop.screenshot", args: {} }] },
        { text: "Safari is open on example.com." },
      ]),
    });
    const planned = await step(room, bot);
    assert.equal(planned.results?.[0]?.planned, true, JSON.stringify(planned));
    const said = await bodies(room.origin, "commons", secret);
    const plan = said.find(body => body.startsWith("Plan:"));
    assert.match(plan, /Reply go and I will start/);
    assert.equal((await claims(room.origin, secret)).length, 0);

    const conversation = await get(room.origin, "/api/rooms/commons/conversation?limit=20", secret);
    const planMessage = conversation.json.messages.find(message => message.body.startsWith("Plan:"));
    const reply = async (token, body, replyToId) => post(room.origin, "/api/rooms/commons/commands", {
      id: randomUUID(),
      type: "message.posted",
      data: { messageId: randomUUID(), body, ...(replyToId ? { replyToId } : {}) },
    }, token);

    const stranger = await reply(minted.secret, "go", planMessage.id);
    assert.equal(stranger.status, 201, JSON.stringify(stranger.json));
    await step(room, bot);
    assert.equal((await claims(room.origin, secret)).length, 0);

    const loose = await reply(room.ownerKey, "go");
    assert.equal(loose.status, 201, JSON.stringify(loose.json));
    await step(room, bot);
    assert.equal((await claims(room.origin, secret)).length, 0);

    const owner = await reply(room.ownerKey, "go", planMessage.id);
    assert.equal(owner.status, 201, JSON.stringify(owner.json));
    const finished = await step(room, bot);
    assert.equal(finished.done, true, JSON.stringify(finished));
    const board = await claims(room.origin, secret);
    const lease = board.find(item => item.title === "Lease desk");
    const work = board.find(item => item.id.startsWith("botw-"));
    assert.equal(lease.state, "done");
    assert.equal(work.state, "done");
    assert.equal(work.kind, "work");
    assert.ok(lease.files.includes("resource/mac-1/desk"));
    assert.ok(lease.blobs.length >= 1);
    assert.match(lease.blobs[0], /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(work.blobs, lease.blobs);
    const after = await bodies(room.origin, "commons", secret);
    const receipt = after.find(body => body.includes("Safari is open on example.com."));
    assert.match(receipt, /Receipt sha256:[0-9a-f]{64}/);
  });

  test("a mention in a room outside the allowlist is acked and gets no reply", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { rooms: ["commons"] });
    room.store.initialize(initialRoom("side"));
    const sideKey = room.store.issueAccessKey("side", "owner");
    const invite = await post(room.origin, "/api/rooms/side/agent-invites", {
      profile: "contribute", displayName: "Room machine",
    }, sideKey);
    assert.equal(invite.status, 201, JSON.stringify(invite.json));
    const secret = await secretOf(room);
    const joined = await redeemInvite(room.origin, {
      code: invite.json.code, displayName: "Room machine", secret,
    });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    await mention(room, MENTION, sideKey, "side");
    const bot = new MachineBot({ home: room.home, env: room.env, waitMs: 0, provider: scripted([]) });
    const result = await step(room, bot);
    assert.equal(result.results?.[0]?.ignored, "allowlist");
    const again = await get(room.origin, "/api/agent-wakes/poll?hostId=room-machine&waitMs=0", secret);
    assert.equal(again.json.pendingWakes.length, 0);
    const said = await bodies(room.origin, "side", sideKey);
    assert.equal(said.some(body => body.startsWith("Plan:") || body === NONE_MESSAGE), false);
  });

  test("a room pause stops the loop before the next step and does not mark the work done", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { tier: "t3" });
    const secret = await secretOf(room);
    let calls = 0;
    const bot = new MachineBot({
      home: room.home,
      env: room.env,
      waitMs: 0,
      provider: scripted([{ actions: [
        { tool: "desktop.screenshot", args: {} },
        { tool: "desktop.screenshot", args: {} },
      ] }]),
      dispatch: async (call) => {
        calls += 1;
        if (calls === 1) {
          const paused = await post(room.origin, "/api/rooms/commons/agent-pause", {
            action: "pause",
            memberId: room.identityId,
            requestId: randomUUID(),
            reason: "stop the bot",
          }, room.ownerKey);
          assert.equal(paused.status, 201, JSON.stringify(paused.json));
        }
        return dispatchTool(call);
      },
    });
    await mention(room);
    const stopped = outcome(await step(room, bot));
    assert.match(stopped.message, /Paused\. I stopped before the next step/);
    assert.equal(calls, 1);
    const board = await claims(room.origin, secret);
    const work = board.find(item => item.id.startsWith("botw-"));
    const lease = board.find(item => item.title === "Lease desk");
    assert.equal(work.state, "blocked");
    assert.equal(lease.state, "unclaimed");
    const said = await bodies(room.origin, "commons", secret);
    assert.equal(said.some(body => body.startsWith("Paused.")), true);
  });

  test("none and a text-only provider refuse before claiming a slot", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { tier: "t3" });
    const secret = await secretOf(room);
    const noneBot = new MachineBot({
      home: room.home, env: room.env, waitMs: 0, provider: createNoneProvider(),
    });
    await mention(room);
    await step(room, noneBot);
    const said = await bodies(room.origin, "commons", secret);
    assert.equal(said.includes(NONE_MESSAGE), true);
    assert.equal((await claims(room.origin, secret)).length, 0);

    let fetched = false;
    const dashaBot = new MachineBot({
      home: room.home,
      env: room.env,
      waitMs: 0,
      provider: createDashaProvider({
        key: "sk-dasha-test",
        model: "room-bot",
        fetchImpl: () => { fetched = true; return jsonResponse({}); },
      }),
    });
    await mention(room, "@Room machine open Safari and send a screenshot again");
    await step(room, dashaBot);
    assert.equal(fetched, false);
    const later = await bodies(room.origin, "commons", secret);
    assert.equal(later.includes(GUI_MESSAGE), true);
    assert.equal((await claims(room.origin, secret)).length, 0);
  });

  test("step, spend, and time caps stop the loop without marking the work done", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { tier: "t3", maxSteps: 1, maxSpendUsd: 1 });
    const secret = await secretOf(room);
    const ran = [];
    let now = 5_000_000;
    let jump = false;
    const turns = [];
    const bot = new MachineBot({
      home: room.home,
      env: room.env,
      waitMs: 0,
      clock: () => now,
      provider: {
        name: "scripted",
        computerUse: true,
        async next() {
          if (jump) now += 10 * 60 * 1000;
          return turns.shift();
        },
      },
      dispatch: async (call) => {
        ran.push(call.args.name);
        return { ok: true, result: { output: "ok" } };
      },
    });

    turns.push({
      actions: [
        { tool: "files.get", args: { name: "one" } },
        { tool: "files.get", args: { name: "two" } },
      ],
      text: "",
      costUsd: 0,
    });
    await mention(room, "@Room machine count the step limit");
    const stepped = outcome(await step(room, bot));
    assert.match(stepped.message, /step limit \(1\)/);
    assert.deepEqual(ran, ["one"]);

    saveBot(room.home, { tier: "t3", maxSteps: 8, maxSpendUsd: 1 });
    turns.push({ actions: [{ tool: "files.get", args: { name: "spend" } }], text: "", costUsd: 2 });
    await mention(room, "@Room machine count the spend limit");
    const spent = outcome(await step(room, bot));
    assert.match(spent.message, /spend limit \(1\)/);
    assert.equal(ran.includes("spend"), false);

    saveBot(room.home, { tier: "t3", maxSteps: 8, maxSpendUsd: 50 });
    turns.push({
      actions: [{ tool: "files.get", args: { name: "wall" } }],
      text: "",
      costUsd: 0,
    });
    jump = true;
    await mention(room, "@Room machine count the time limit");
    const timed = outcome(await step(room, bot));
    assert.match(timed.message, /time limit/);
    assert.equal(ran.includes("wall"), false);

    const board = await claims(room.origin, secret);
    const works = board.filter(item => item.id.startsWith("botw-"));
    assert.equal(works.length, 3);
    assert.equal(works.every(item => item.state === "blocked"), true);
    assert.equal(works.some(item => item.state === "done"), false);
  });

  test("progress is posted at most once per interval", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { tier: "t3", progressIntervalMs: 120000 });
    const secret = await secretOf(room);
    let now = 1_000_000;
    let tools = 0;
    const bot = new MachineBot({
      home: room.home,
      env: room.env,
      waitMs: 0,
      clock: () => now,
      provider: scripted([
        { actions: [
          { tool: "files.get", args: { name: "a" } },
          { tool: "files.get", args: { name: "b" } },
          { tool: "files.get", args: { name: "c" } },
        ] },
        { text: "listed" },
      ]),
      dispatch: async () => {
        tools += 1;
        if (tools === 1) now += 120000;
        return { ok: true, result: { output: "ok" } };
      },
    });
    await mention(room, "@Room machine list three files");
    const finished = outcome(await step(room, bot));
    assert.equal(finished.done, true, JSON.stringify(finished));
    assert.equal(tools, 3);
    const said = await bodies(room.origin, "commons", secret);
    const progress = said.filter(body => body.startsWith("Still working."));
    assert.deepEqual(progress, ["Still working. Step 1."]);
  });

  test("only the owner can approve a desk shell, a spent code does not approve again, and an unanswered code expires", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { tier: "t3" });
    const secret = await secretOf(room);
    const strangerInvite = await post(room.origin, "/api/rooms/commons/agent-invites", {
      profile: "chat", displayName: "Other member",
    }, room.ownerKey);
    assert.equal(strangerInvite.status, 201, JSON.stringify(strangerInvite.json));
    const minted = await mintIdentity(room.origin, "Other member");
    const redeemed = await redeemInvite(room.origin, {
      code: strangerInvite.json.code, displayName: "Other member", secret: minted.secret,
    });
    assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
    const env = { ...room.env, ROOM_MACHINE_APPROVAL_WAIT_MS: "2000" };
    const bot = new MachineBot({
      home: room.home,
      env,
      waitMs: 0,
      provider: scripted([{ actions: [
        { tool: "shell.vm", args: { command: "echo one" } },
        { tool: "shell.vm", args: { command: "echo two" } },
      ] }]),
    });
    await mention(room, "@Room machine run a desk shell");
    const running = step({ ...room, env }, bot);
    let firstCode = null;
    await waitFor(async () => {
      const said = await bodies(room.origin, "commons", secret);
      const line = said.find(body => /^approve [0-9a-f]{6} to let /.test(body));
      if (!line) return false;
      firstCode = line.split(" ")[1];
      return true;
    });
    const stranger = await post(room.origin, "/api/rooms/commons/commands", {
      id: randomUUID(),
      type: "message.posted",
      data: { messageId: randomUUID(), body: `approve ${firstCode}` },
    }, minted.secret);
    assert.equal(stranger.status, 201, JSON.stringify(stranger.json));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(readFileSync(join(room.home, "argv-log"), "utf8").includes("echo one"), false);
    const owner = await post(room.origin, "/api/rooms/commons/commands", {
      id: randomUUID(),
      type: "message.posted",
      data: { messageId: randomUUID(), body: `approve ${firstCode}` },
    }, room.ownerKey);
    assert.equal(owner.status, 201, JSON.stringify(owner.json));
    await waitFor(() => readFileSync(join(room.home, "argv-log"), "utf8").includes("echo one"));
    let secondCode = null;
    await waitFor(async () => {
      const said = await bodies(room.origin, "commons", secret);
      const line = said.find(body => /^approve [0-9a-f]{6} to let /.test(body) && !body.includes(firstCode));
      if (!line) return false;
      secondCode = line.split(" ")[1];
      return true;
    });
    const reused = await post(room.origin, "/api/rooms/commons/commands", {
      id: randomUUID(),
      type: "message.posted",
      data: { messageId: randomUUID(), body: `approve ${firstCode}` },
    }, room.ownerKey);
    assert.equal(reused.status, 201, JSON.stringify(reused.json));
    const stopped = outcome(await running);
    assert.match(stopped.message, /approval expired|did not approve/);
    assert.equal(readFileSync(join(room.home, "argv-log"), "utf8").includes("echo two"), false);
    assert.notEqual(secondCode, firstCode);

    saveBot(room.home, { tier: "t3" });
    const expiring = new MachineBot({
      home: room.home,
      env: { ...room.env, ROOM_MACHINE_APPROVAL_WAIT_MS: "0" },
      waitMs: 0,
      provider: scripted([{ actions: [{ tool: "shell.vm", args: { command: "echo three" } }] }]),
    });
    await mention(room, "@Room machine run another desk shell");
    const expired = outcome(await step(room, expiring));
    assert.match(expired.message, /approval expired/);
    assert.equal(readFileSync(join(room.home, "argv-log"), "utf8").includes("echo three"), false);
    const board = await claims(room.origin, secret);
    assert.equal(board.filter(item => item.id.startsWith("botw-")).every(item => item.state !== "done"), true);
  });

  test("a provider key stays out of room posts, logs, argv, and the child environment", async (t) => {
    const room = await enrolled(t);
    const key = "sk-bot-test-DoNotLeak-0000";
    const refused = spawnSync(process.execPath, [cli, "provider", "set", "anthropic", key], {
      env: room.env, encoding: "utf8",
    });
    assert.notEqual(refused.status, 0);
    assert.equal(`${refused.stdout}\n${refused.stderr}`.includes(key), false);
    assert.equal(readFileSync(join(room.home, "config.json"), "utf8").includes(key), false);
    const set = spawnSync(process.execPath, [cli, "provider", "set", "anthropic"], {
      env: room.env, input: `${key}\n`, encoding: "utf8",
    });
    assert.equal(set.status, 0, `${set.stdout}\n${set.stderr}`);
    assert.equal(set.stdout.includes(key), false);
    const configText = readFileSync(join(room.home, "config.json"), "utf8");
    assert.equal(configText.includes(key), false);
    assert.match(configText, /"provider": "anthropic"/);
    assert.equal(readFileSync(join(room.home, "argv-log"), "utf8").includes(key), false);
    assert.equal(readFileSync(join(room.home, "env-log"), "utf8").includes(key), false);
    assert.equal(readFileSync(join(room.home, "secrets", "provider-anthropic"), "utf8").trim(), key);

    saveBot(room.home, { tier: "t3" });
    const requests = [];
    const bot = new MachineBot({
      home: room.home,
      env: room.env,
      waitMs: 0,
      fetchImpl: async (url, init) => {
        requests.push({ url, headers: init.headers, body: init.body });
        const body = JSON.parse(init.body);
        const followUp = body.messages.some(message => message.role === "assistant");
        if (!followUp) {
          return jsonResponse({ content: [{ type: "tool_use", id: "toolu_k", input: { action: "screenshot" } }] });
        }
        return jsonResponse({ content: [{ type: "text", text: "Desktop is idle." }] });
      },
    });
    await mention(room, "@Room machine open Safari and send a screenshot quietly");
    const finished = outcome(await step(room, bot));
    assert.equal(finished.done, true, JSON.stringify(finished));
    assert.equal(requests.length >= 1, true);
    for (const request of requests) {
      assert.equal(request.headers["x-api-key"], key);
      assert.equal(String(request.body).includes(key), false);
    }
    const secret = await secretOf(room);
    const said = await bodies(room.origin, "commons", secret);
    assert.equal(said.some(body => body.includes(key)), false);
    assert.equal(readFileSync(join(room.home, "argv-log"), "utf8").includes(key), false);
    assert.equal(readFileSync(join(room.home, "env-log"), "utf8").includes(key), false);
    assert.equal(readFileSync(join(room.home, "bot-state.json"), "utf8").includes(key), false);
    assert.equal(readFileSync(join(room.home, "config.json"), "utf8").includes(key), false);
  });

  test("a handled update is acked without a plan, and a long mention is planned from the full message", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { tier: "t1" });
    const secret = await secretOf(room);
    const bot = new MachineBot({ home: room.home, env: room.env, waitMs: 0, provider: scripted([]) });
    const posted = await mention(room, "@Room machine short task");
    const messageId = posted.event?.data?.messageId;
    assert.equal(typeof messageId, "string");
    const listed = await get(room.origin, "/api/rooms/commons/updates?state=actionable", secret);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    const item = (listed.json.items ?? []).find(entry => entry.sourceRef?.messageId === messageId);
    assert.ok(item, JSON.stringify(listed.json.items));
    const done = await post(room.origin, `/api/rooms/commons/updates/${item.id}/done`, { requestId: randomUUID(), expectedBasis: item.basisToken }, secret);
    assert.equal(done.status, 200, JSON.stringify(done.json));
    const skipped = await step(room, bot);
    assert.equal(skipped.results?.[0]?.ignored, "handled", JSON.stringify(skipped));
    assert.equal((await bodies(room.origin, "commons", secret)).some(body => body.startsWith("Plan:")), false);
    const polled = await get(room.origin, "/api/agent-wakes/poll?hostId=room-machine&waitMs=0", secret);
    assert.equal(polled.json.pendingWakes.length, 0);

    const tail = "TAIL-TOKEN-beyond-the-clip";
    await mention(room, `@Room machine ${"x".repeat(130)} ${tail}`);
    const planned = await step(room, bot);
    assert.equal(planned.results?.[0]?.planned, true, JSON.stringify(planned));
    const plan = (await bodies(room.origin, "commons", secret)).find(body => body.startsWith("Plan:"));
    assert.match(plan, new RegExp(tail));
    const open = await get(room.origin, "/api/rooms/commons/updates?state=actionable", secret);
    assert.equal((open.json.items ?? []).some(entry => String(entry.title).includes(tail)), false);
  });

  test("the room API marks the observed update basis and explicitly skips a tokenless mark", async (t) => {
    const room = await enrolled(t);
    const secret = await secretOf(room);
    const posted = await mention(room, "@Room machine observe this update");
    const { item } = await listedUpdate(room, secret, posted.event.data.messageId);
    assert.match(item.basisToken, /^ub1_[0-9a-f]{64}$/);
    const requests = trackUpdateRequests(room.server);
    const api = createRoomApi({ origin: room.origin, secret });
    const skipped = await api.markUpdate("commons", item.id, "read");
    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, "update_basis_required");
    assert.equal(requests.length, 0, "a missing basis must not trigger a write or a refresh");

    const marked = await api.markUpdate("commons", item.id, "read", item.basisToken);
    assert.equal(marked.ok, true, JSON.stringify(marked));
    assert.equal(marked.value.item.state, "read");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].path, `/api/rooms/commons/updates/${item.id}/read`);
    assert.equal(requests[0].status, 200);
    const current = await listedUpdate(room, secret, posted.event.data.messageId);
    assert.equal(current.item.state, "read");
  });

  test("a mention reply sends its queued basis and stale refusal leaves no private mark", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { tier: "t3" });
    const secret = await secretOf(room);
    const posted = await mention(room, "@Room machine reply without taking a slot");
    const { item, viewerId } = await listedUpdate(room, secret, posted.event.data.messageId);
    const requests = trackUpdateRequests(room.server);
    const bot = new MachineBot({ home: room.home, env: room.env, waitMs: 0, provider: createNoneProvider() });
    const result = await step(room, bot);
    assert.equal(result.results[0].refused, "none", JSON.stringify(result));
    assert.equal((await bodies(room.origin, "commons", secret)).includes(NONE_MESSAGE), true);
    const writes = requests.filter(request => request.method === "POST");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, `/api/rooms/commons/updates/${item.id}/done`);
    assert.equal(writes[0].status, 409, "the reply changes the mention basis before the private mark");
    assert.equal(requests.filter(request => request.method === "GET").length, 1, "do not refresh and retry a stale mark");
    const current = await listedUpdate(room, secret, posted.event.data.messageId);
    assert.notEqual(current.item.basisToken, item.basisToken);
    assert.equal(current.item.state, "answered", "reply semantics still come from the source journal");
    assert.equal(room.store.db.prepare(
      "SELECT action FROM private_update_marks WHERE room_id=? AND member_id=? AND item_id=?"
    ).get("commons", viewerId, item.id), undefined);
    assert.equal(room.store.db.prepare(
      "SELECT COUNT(*) AS count FROM private_update_commands WHERE room_id=? AND member_id=?"
    ).get("commons", viewerId).count, 0);
  });

  test("pending and active restarts retain the original update basis through completion", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { tier: "t1" });
    const secret = await secretOf(room);
    const posted = await mention(room, "@Room machine resume this task after restart");
    const { item } = await listedUpdate(room, secret, posted.event.data.messageId);
    const planner = new MachineBot({ home: room.home, env: room.env, waitMs: 0, provider: scripted([]) });
    const planned = await step(room, planner);
    assert.equal(planned.results[0].planned, true, JSON.stringify(planned));
    const pendingState = JSON.parse(readFileSync(join(room.home, "bot-state.json"), "utf8"));
    assert.equal(pendingState.pending.basisToken, item.basisToken);

    const resumed = new MachineBot({
      home: room.home, env: room.env, waitMs: 0,
      provider: scripted([{ actions: [{ tool: "files.get", args: { name: "checkpoint" } }] }]),
      dispatch: async () => {
        await resumed.stop();
        return { ok: true, result: { output: "checkpoint" } };
      },
    });
    const go = await post(room.origin, "/api/rooms/commons/commands", {
      id: randomUUID(), type: "message.posted",
      data: { messageId: randomUUID(), body: "go", replyToId: pendingState.pending.planMessageId },
    }, room.ownerKey);
    assert.equal(go.status, 201, JSON.stringify(go.json));
    const stopped = await step(room, resumed);
    assert.equal(stopped.stopped, true, JSON.stringify(stopped));
    const activeState = JSON.parse(readFileSync(join(room.home, "bot-state.json"), "utf8"));
    assert.equal(activeState.pending, null);
    assert.equal(activeState.active.basisToken, item.basisToken);
    assert.equal(activeState.active.updateId, item.id);

    const requests = trackUpdateRequests(room.server);
    const restarted = new MachineBot({
      home: room.home, env: room.env, waitMs: 0, provider: scripted([{ text: "Resumed task complete." }]),
    });
    const finished = await step(room, restarted);
    assert.equal(finished.done, true, JSON.stringify(finished));
    assert.equal(finished.closed, true, JSON.stringify(finished));
    assert.equal(requests.length, 1, "resumed work must not fetch a newer basis");
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].path, `/api/rooms/commons/updates/${item.id}/done`);
    assert.equal(requests[0].status, 409);
    const board = await claims(room.origin, secret);
    assert.equal(board.find(claim => claim.id === finished.workId).state, "done");
    assert.equal(board.find(claim => claim.id === finished.leaseId).state, "done");
    const saved = JSON.parse(readFileSync(join(room.home, "bot-state.json"), "utf8"));
    assert.equal(saved.pending, null);
    assert.equal(saved.active, null);
  });

  test("legacy pending and active state reply without refreshing or marking an unseen basis", async (t) => {
    for (const stateName of ["pending", "active"]) {
      await t.test(stateName, async (t) => {
        const room = await enrolled(t);
        saveBot(room.home, { tier: stateName === "pending" ? "t1" : "t3" });
        const secret = await secretOf(room);
        const posted = await mention(room, "@Room machine finish a legacy saved task");
        const { item, viewerId } = await listedUpdate(room, secret, posted.event.data.messageId);
        const original = new MachineBot({
          home: room.home, env: room.env, waitMs: 0,
          provider: scripted([{ actions: [{ tool: "files.get", args: { name: "checkpoint" } }] }]),
          dispatch: async () => {
            await original.stop();
            return { ok: true, result: { output: "checkpoint" } };
          },
        });
        await step(room, original);
        const statePath = join(room.home, "bot-state.json");
        const legacy = JSON.parse(readFileSync(statePath, "utf8"));
        assert.equal(legacy[stateName].updateId, item.id);
        delete legacy[stateName].basisToken;
        writeFileSync(statePath, JSON.stringify(legacy));
        if (stateName === "pending") {
          const go = await post(room.origin, "/api/rooms/commons/commands", {
            id: randomUUID(), type: "message.posted",
            data: { messageId: randomUUID(), body: "go", replyToId: legacy.pending.planMessageId },
          }, room.ownerKey);
          assert.equal(go.status, 201, JSON.stringify(go.json));
        }
        const requests = trackUpdateRequests(room.server);
        const restarted = new MachineBot({
          home: room.home, env: room.env, waitMs: 0, provider: scripted([{ text: "Legacy task complete." }]),
        });
        const finished = await step(room, restarted);
        assert.equal(finished.done, true, JSON.stringify(finished));
        assert.equal(finished.closed, true, JSON.stringify(finished));
        assert.equal((await bodies(room.origin, "commons", secret)).some(body => body.startsWith("Legacy task complete.")), true);
        assert.deepEqual(requests, [], "old state must neither mark nor fetch a basis it never observed");
        assert.equal(room.store.db.prepare(
          "SELECT action FROM private_update_marks WHERE room_id=? AND member_id=? AND item_id=?"
        ).get("commons", viewerId, item.id), undefined);
      });
    }
  });

  test("room-machine run starts the bot loop when bot.enabled is on", async (t) => {
    const room = await enrolled(t);
    saveBot(room.home, { tier: "t3" });
    const config = loadConfig(room.home);
    saveConfig({ ...config, provider: "none", bot: { ...config.bot, enabled: true, rooms: ["commons"], tier: "t3" } }, room.home);
    const daemon = new MachineDaemon({ home: room.home, env: room.env });
    try {
      const started = await spawnContext.run({ env: room.env }, () => daemon.start());
      assert.equal(started.enrolled, true);
      await mention(room, "@Room machine open Safari and send a screenshot from the daemon");
      const secret = await secretOf(room);
      await waitFor(async () => (await bodies(room.origin, "commons", secret)).includes(NONE_MESSAGE));
      const board = await claims(room.origin, secret);
      assert.equal(board.length, 0);
    } finally {
      await daemon.stop();
    }
  });
});
