import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RoomClient, draftCommand } from "../src/client.js";

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const snapshot = (sequence, viewerId = "human") => ({ sequence, state: {}, cursor: 0, viewerId });
const identity = (id = "human") => ({ member: { id }, roomId: "commons", csrf: "session-confirmation" });
test("unchanged draft retries retain ID and content changes require a new ID", () => {
  const first = draftCommand(null, "message.posted", { body: "hello" });
  assert.equal(draftCommand(first, "message.posted", { body: "hello" }), first);
  assert.notEqual(draftCommand(first, "message.posted", { body: "changed" }).command.id, first.command.id);
});
test("failed command leaves retry object unchanged and never reports a receipt", async () => {
  const client = new RoomClient({ fetcher: async () => response({ error: { message: "Stale revision" } }, 409) });
  client.session = identity();
  const pending = draftCommand(null, "work.started", { workItemId: "work", expectedRevision: 0 });
  const before = JSON.stringify(pending);
  await assert.rejects(client.send(pending.command), /Stale revision/);
  assert.equal(JSON.stringify(pending), before);
});
test("committed command is not reported as failed when the refresh disconnects", async () => {
  let calls = 0, status = "";
  const client = new RoomClient({ fetcher: async () => { if (calls++ === 0) return response({ sequence: 9 }); throw new Error("offline"); }, onStatus: text => status = text });
  client.session = identity();
  assert.equal((await client.send({ id: "one", type: "message.posted", data: { body: "hello" } })).sequence, 9);
  assert.match(status, /interrupted/);
});
test("simultaneous refreshes coalesce and do not drop a pending newer event", async () => {
  let release, calls = 0; const seen = [];
  const client = new RoomClient({ fetcher: async () => { calls++; if (calls === 1) return new Promise(resolve => release = () => resolve(response(snapshot(4)))); return response(snapshot(5)); }, onSnapshot: s => seen.push(s.sequence) });
  client.session = identity();
  const first = client.refresh(), second = client.refresh();
  release(); await Promise.all([first, second]);
  assert.deepEqual(seen, [4, 5]); assert.equal(calls, 2);
});
test("late old-session snapshots cannot repopulate a signed-out or switched account", async () => {
  let release; const seen = [];
  const client = new RoomClient({ fetcher: () => new Promise(resolve => release = () => resolve(response(snapshot(99)))), onSnapshot: s => seen.push(s.sequence) });
  client.session = identity();
  const old = client.refresh(); client.endAccess(); release(); await old;
  assert.deepEqual(seen, []); assert.equal(client.session, null);
  client.fetcher = async () => response(snapshot(2, "other")); client.session = identity("other");
  await client.refresh(); assert.deepEqual(seen, [2]);
});
test("cookie account changes are detected before displaying an incorrectly attributed room", async () => {
  let ended = false, shown = false;
  const client = new RoomClient({ fetcher: async () => response(snapshot(8, "other")), onAccessEnded: () => ended = true, onSnapshot: () => shown = true });
  client.session = identity(); await client.refresh();
  assert.equal(ended, true); assert.equal(shown, false);
});
test("a late command receipt never refreshes or ends a different session", async () => {
  for (const status of [201, 401]) {
    let release, calls = 0, ended = false;
    const client = new RoomClient({ fetcher: () => { calls++; return new Promise(resolve => release = () => resolve(response(status === 201 ? { sequence: 9 } : { error: { message: "Old session ended" } }, status))); }, onAccessEnded: () => ended = true });
    client.session = identity();
    const sent = client.send({ id: "late", type: "message.posted", data: { body: "Old room" } });
    client.disconnect(); client.session = identity("other");
    release();
    if (status === 201) await sent; else await assert.rejects(sent, /Old session/);
    assert.equal(calls, 1); assert.equal(ended, false); assert.equal(client.session.member.id, "other");
  }
});
test("connected UI hooks exist and demo controls are not exposed", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of app.matchAll(/\$\("#([a-z-]+)"\)/g)) assert.ok(ids.includes(match[1]), `Missing UI hook ${match[1]}`);
  assert.doesNotMatch(app, /from "\.\/(seed|storage)\.js"/);
  assert.doesNotMatch(html, /actor-select|reset-button|4 here now|Simulate actor/);
  assert.match(html, /id="main"[^>]*hidden/);
});
