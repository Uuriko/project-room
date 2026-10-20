// Room Everywhere P2: the plugin hooks pack. Session start summarizes unread
// mentions; stop blocks once per batch of new mentions and never leaks the
// token, loops forever, or fails closed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, stateDir } from "../plugins/project-room/hooks/room-mentions.mjs";

const TOKEN = "secret-token-value";
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "room-hooks-"));
  writeFileSync(join(dir, "connection.json"), JSON.stringify({ origin: "https://room.example", roomId: "r1", token: TOKEN }));
  return { ROOM_AGENT_CONFIG: dir };
};
const fetchWith = rows => async (url, init) => {
  assert.match(String(url), /\/api\/rooms\/r1\/mentions\?state=delivered$/);
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  return { ok: true, json: async () => ({ mentions: rows }) };
};
const run = async (mode, env, fetchImpl, input = {}) => {
  let text = "";
  await main(mode, { env, fetchImpl, input, out: s => { text += s; } });
  return text;
};
const row = id => ({ messageEventId: id, state: "delivered", createdAt: "2026-10-20T00:00:00.000Z" });

test("session start summarizes unread mentions without the token", async () => {
  const text = await run("session-start", setup(), fetchWith([row("m1"), row("m2")]));
  assert.match(text, /r1: 2 unread @mentions: m1/);
  assert.ok(!text.includes(TOKEN));
});

test("stop blocks once for new mentions, then lets the agent stop", async () => {
  const env = setup();
  await run("session-start", env, fetchWith([row("m1")]));
  assert.equal(await run("stop", env, fetchWith([row("m1")])), "");
  const blocked = JSON.parse(await run("stop", env, fetchWith([row("m1"), row("m2")])));
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /1 new @mention since you last checked: m2/);
  assert.ok(!blocked.reason.includes(TOKEN));
  assert.equal(await run("stop", env, fetchWith([row("m1"), row("m2")]), { stop_hook_active: true }), "");
  const seen = JSON.parse(readFileSync(join(env.ROOM_AGENT_CONFIG, "hook-mentions-seen.json"), "utf8"));
  assert.deepEqual(seen.ids.sort(), ["m1", "m2"]);
});

test("stop caps consecutive blocks while the hook is active", async () => {
  const env = setup();
  let n = 0;
  const outs = [];
  for (let i = 0; i < 5; i++) outs.push(await run("stop", env, fetchWith([row(`x${n++}`)]), { stop_hook_active: i > 0 }));
  assert.equal(outs.filter(Boolean).length, 3);
});

test("fails open: no config, bad response, or network error", async () => {
  assert.match(await run("session-start", {}, fetchWith([])), /set ROOM_AGENT_CONFIG/);
  assert.equal(await run("stop", {}, fetchWith([])), "");
  const env = setup();
  assert.equal(await run("stop", env, async () => ({ ok: false, status: 401 })), "");
  assert.match(await run("session-start", env, async () => { throw new Error("down"); }), /could not be read/);
});

test("hooks.json wires both events to the script in the plugin root", () => {
  const hooks = JSON.parse(readFileSync(new URL("../plugins/project-room/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  for (const [event, mode] of [["SessionStart", "session-start"], ["Stop", "stop"]]) {
    const command = hooks[event][0].hooks[0].command;
    assert.equal(command, `node "\${CLAUDE_PLUGIN_ROOT}/hooks/room-mentions.mjs" ${mode}`);
  }
});

test("seen state uses the host plugin data dir when present (Codex PLUGIN_DATA, Claude CLAUDE_PLUGIN_DATA)", async () => {
  const env = setup();
  const data = mkdtempSync(join(tmpdir(), "room-hooks-data-"));
  assert.equal(stateDir({ ...env, PLUGIN_DATA: data }, { dir: env.ROOM_AGENT_CONFIG }), data);
  assert.equal(stateDir({ ...env, CLAUDE_PLUGIN_DATA: data }, { dir: env.ROOM_AGENT_CONFIG }), data);
  assert.equal(stateDir(env, { dir: env.ROOM_AGENT_CONFIG }), env.ROOM_AGENT_CONFIG);
  await run("session-start", { ...env, PLUGIN_DATA: data }, fetchWith([row("m9")]));
  assert.deepEqual(JSON.parse(readFileSync(join(data, "hook-mentions-seen.json"), "utf8")).ids, ["m9"]);
});

test("hook commands only use a plugin-root variable both hosts substitute", () => {
  const hooks = JSON.parse(readFileSync(new URL("../plugins/project-room/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  for (const entries of Object.values(hooks)) {
    for (const { command } of entries[0].hooks) {
      const vars = [...command.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]);
      assert.ok(vars.length > 0 && vars.every(v => v === "CLAUDE_PLUGIN_ROOT" || v === "PLUGIN_ROOT"), command);
    }
  }
});
