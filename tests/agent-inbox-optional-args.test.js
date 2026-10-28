// Regression for #2880: the documented optional arguments for `find` and
// `apply-template` were always rejected as usage_error, because the
// argument-validation chain in scripts/agent-inbox.mjs fell through to a
// blanket `extra.length` rejection for those two actions even though the
// dispatch below them (client.search with a kind, applyRoomTemplate with
// an accountableMemberId) and --help both support the extra argument.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-optional-args-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, ownerKey, origin };
}

function environment(f) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("ROOM_AGENT_") || name === "NODE_OPTIONS") delete env[name];
  // Legacy unpinned environment credentials (no ROOM_AGENT_MEMBER): the
  // bootstrap owner key is not member-pinned (same as
  // tests/room-templates.test.js); pinning "owner" trips identity_mismatch,
  // and a saved connection cannot be unpinned.
  return { ...env, NODE_NO_WARNINGS: "1", ROOM_AGENT_ORIGIN: f.origin, ROOM_AGENT_ROOM: "commons", ROOM_AGENT_TOKEN: f.ownerKey };
}

async function cli(f, args) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["scripts/agent-inbox.mjs", ...args], {
      env: environment(f), encoding: "utf8", timeout: 15000,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("find accepts its documented optional kind argument (#2880)", async t => {
  const f = await setup(t);
  f.store.command(f.ownerKey, "commons", { id: "find-seed-message", type: "message.posted",
    data: { messageId: "find-msg-1", body: "needle2880 in a message" } });
  f.store.command(f.ownerKey, "commons", { id: "find-seed-work", type: "work.proposed",
    data: { workItemId: "find-work-1", title: "needle2880 work title", definitionOfDone: "Ship the needle2880 fix.",
      accountableMemberId: "owner", independentVerificationRequired: false, ownerDecisionRequired: false } });

  const messages = await cli(f, ["find", "needle2880", "messages"]);
  assert.equal(messages.status, 0, messages.stderr);
  const messagesResult = JSON.parse(messages.stdout);
  assert.deepEqual(messagesResult.messages.map(m => m.id), ["find-msg-1"]);
  assert.deepEqual(messagesResult.workItems, []);

  const work = await cli(f, ["find", "needle2880", "work"]);
  assert.equal(work.status, 0, work.stderr);
  const workResult = JSON.parse(work.stdout);
  assert.deepEqual(workResult.messages, []);
  assert.deepEqual(workResult.workItems.map(w => w.id), ["find-work-1"]);

  for (const args of [["find", "needle2880", "all"], ["find", "needle2880"]]) {
    const result = await cli(f, args);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.messages.map(m => m.id), ["find-msg-1"]);
    assert.deepEqual(parsed.workItems.map(w => w.id), ["find-work-1"]);
  }
});

test("apply-template accepts its documented optional accountable member (#2880)", async t => {
  const f = await setup(t);
  const result = await cli(f, ["apply-template", "team-standup", "owner"]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.template, "team-standup");
  assert.equal(receipt.charter, "updated");
  assert.equal(receipt.workItems.length, 2);
  assert.ok(receipt.workItems.every(w => w.workItemId));
  // Every seeded work item is accountable to the member passed as the
  // optional argument, not silently to someone else.
  const state = f.store.room("commons").state;
  for (const w of receipt.workItems) assert.equal(state.workItems[w.workItemId].accountableMemberId, "owner");

  // And without the optional argument the command still works (the
  // accountable member defaults to the caller).
  const again = await cli(f, ["apply-template", "team-standup"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).template, "team-standup");
});

test("find and apply-template still reject excess or invalid arguments (#2880)", async t => {
  const f = await setup(t);
  const cases = [
    ["find", "needle2880", "bogus-kind"],
    ["find", "needle2880", "messages", "extra"],
    ["find"],
    ["apply-template", "team-standup", "owner", "extra"],
    ["apply-template"],
  ];
  for (const args of cases) {
    const result = await cli(f, args);
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stdout} ${result.stderr}`);
    assert.equal(JSON.parse(result.stderr).code, "usage_error", `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
  }
});
