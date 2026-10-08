import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { PURGE_TABLES } from "../server/purge-registry.mjs";

// #2103 (REL-25) persists feedback in feedback_state, created on first use.
// CI went red because the table was not registered: auditRecovery refused any
// room that had feedback, and room purge left its row behind. These run the
// real HTTP handler on a real RoomStore. Each call runs in its own Node
// process on one room database: a restart between every request.

const root = fileURLToPath(new URL("..", import.meta.url));

function run(filename, step) {
  const script = `
    import { RoomStore } from ${JSON.stringify(join(root, "server/store.mjs"))};
    import { initialRoom } from ${JSON.stringify(join(root, "server/bootstrap.mjs"))};
    import { handleFeedback } from ${JSON.stringify(join(root, "server/feedback-routes.mjs"))};
    const step = ${JSON.stringify(step)};
    const store = new RoomStore(${JSON.stringify(filename)});
    if (step.init) store.initialize(initialRoom("commons", "owner"));
    const helpers = {
      json: (_res, status, value) => ({ status, value }),
      body: async () => step.body,
      reject: (status, code, message) => { throw Object.assign(new Error(message), { status, code }); },
    };
    let out;
    try {
      out = await handleFeedback({ req: { method: step.method }, res: {}, store, roomId: "commons",
        auth: { member: { id: step.lane, kind: "agent" } }, feedbackRoute: step.route, feedbackId: step.id, helpers });
    } catch (e) { out = { status: e.status ?? 500, value: { code: e.code, message: e.message } }; }
    store.close();
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const filing = observed => ({
  agent: { key_id: "k1" }, endpoint: { method: "POST", path: "/api/rooms/commons/work-claims/x/claim" },
  attempt: { goal: "claim a held task", request: { method: "POST", path: "/api/rooms/commons/work-claims/x/claim" }, response: { status: 409 } },
  observed, expected: "a hint naming the conflict", severity: "bug",
});

test("feedback filings survive a restart and ids are never reused", t => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-durable-")), filename = join(dir, "room.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = run(filename, { init: true, method: "POST", route: "submit", lane: "owner", body: filing("first report") });
  assert.equal(first.status, 202, JSON.stringify(first));
  assert.equal(first.value.feedback_id, "fb-000001");

  const poll = run(filename, { method: "GET", route: "read", id: "fb-000001", lane: "owner" });
  assert.equal(poll.status, 200, JSON.stringify(poll));
  assert.equal(poll.value.feedback_id, "fb-000001");

  const list = run(filename, { method: "GET", route: "list", lane: "owner" });
  assert.equal(list.value.clusters.length, 1);
  assert.equal(list.value.your_mark.balance, 9); // the filing's 1 Mark is still spent

  const second = run(filename, { method: "POST", route: "submit", lane: "owner", body: filing("a different report on another path") });
  assert.equal(second.status, 202, JSON.stringify(second));
  assert.equal(second.value.feedback_id, "fb-000002");
});

test("a refused request leaves the stored feedback unchanged", t => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-durable-")), filename = join(dir, "room.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  run(filename, { init: true, method: "POST", route: "submit", lane: "owner", body: filing("first report") });
  const bad = run(filename, { method: "POST", route: "submit", lane: "owner", body: { ...filing("x"), severity: "nope" } });
  assert.equal(bad.status, 422);
  const list = run(filename, { method: "GET", route: "list", lane: "owner" });
  assert.equal(list.value.clusters.length, 1);
});

test("a room with stored feedback still passes the recovery audit", t => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-durable-")), filename = join(dir, "room.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  run(filename, { init: true, method: "POST", route: "submit", lane: "owner", body: filing("first report") });
  const store = new RoomStore(filename);
  t.after(() => store.close());
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM feedback_state").get().n, 1);
  assert.doesNotThrow(() => auditRecovery(store));
});

test("room purge deletes the room's feedback row", t => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-durable-")), filename = join(dir, "room.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  run(filename, { init: true, method: "POST", route: "submit", lane: "owner", body: filing("first report") });
  const entry = PURGE_TABLES.find(row => row.table === "feedback_state");
  assert.ok(entry, "feedback_state is in the purge registry");
  assert.equal(entry.action, "delete");
  assert.deepEqual(entry.match.room, ["room_id"]);
});
