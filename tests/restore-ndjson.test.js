// H2 backup/DR: whole-store NDJSON restore into an already-open store.
// The Durable Object cannot accept a sqlite file, so restore must replay the
// NDJSON export (server/room-export.mjs format) through the store's own db
// handle. replayNdjson (file-based, node-only) cannot cover that contract;
// these tests own the into-an-open-store path plus the operator endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonText } from "../server/room-export.mjs";
import { replayNdjsonInto, operatorRestoreResponse } from "../server/restore-ndjson.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const OPERATOR_TOKEN = "operator-token-for-restore-tests";

function openStore(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seed(t) {
  const store = openStore(t, "restore-ndjson-seed-");
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Restore agent", kind: "agent", permissions: ["accept_work"] } });
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "history that must survive the restore" } });
  return { store, ndjson: exportNdjsonText(store.db) };
}

function fakeRequest({ method = "POST", body = "", token = OPERATOR_TOKEN, contentLength } = {}) {
  const headers = new Headers({ "content-type": "application/x-ndjson" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return { method, url: "https://room.example/api/operator/restore", headers, text: async () => body };
}

test("replayNdjsonInto restores a whole-store export into an empty open store", t => {
  const { ndjson, store: seeded } = seed(t);
  const events = seeded.db.prepare("SELECT count(*) AS n FROM events").get().n;
  const target = openStore(t, "restore-ndjson-target-"); // migrated schema, no rooms row
  const result = replayNdjsonInto(ndjson, target);
  assert.equal(result.verified, true);
  assert.equal(result.events, events);
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM events").get().n, events);
  const row = target.db.prepare("SELECT body FROM events WHERE body LIKE '%history that must survive the restore%'").get();
  assert.ok(row, "restored history is readable");
  assert.ok(target.room("commons").state.members.agent, "restored members are present");
});

test("replayNdjsonInto refuses a non-empty store — restore never overwrites live data", t => {
  const { ndjson, store } = seed(t);
  assert.throws(() => replayNdjsonInto(ndjson, store), /non-empty/);
  // The refused store is untouched.
  assert.ok(store.db.prepare("SELECT 1 FROM rooms LIMIT 1").get(), "live store keeps its rooms row");
});

test("a truncated export fails the watermark check instead of restoring partial", t => {
  const { ndjson } = seed(t);
  const lines = ndjson.trim().split("\n");
  const eventLine = lines.findIndex(line => line.includes('"table":"events"'));
  assert.ok(eventLine > 0, "fixture export has event rows to truncate");
  const truncated = [...lines.slice(0, eventLine), ...lines.slice(eventLine + 1)].join("\n") + "\n";
  const target = openStore(t, "restore-ndjson-truncated-");
  assert.throws(() => replayNdjsonInto(truncated, target), /watermark/i);
  assert.ok(!target.db.prepare("SELECT 1 FROM rooms LIMIT 1").get(), "failed replay leaves the store empty");
});

test("per-table watermark counts catch truncation outside the event log", t => {
  const { ndjson } = seed(t);
  const lines = ndjson.trim().split("\n");
  // Simulate a newer exporter that pins per-table counts, then corrupt one
  // table's count (as a dropped row would): the replay must fail loudly even
  // though the event-log count still matches.
  const tables = {};
  for (const line of lines.slice(1)) {
    const record = JSON.parse(line);
    tables[record.table] = (tables[record.table] ?? 0) + 1;
  }
  const victim = Object.keys(tables).find(name => name !== "events" && tables[name] > 0);
  assert.ok(victim, "fixture export has non-event tables");
  tables[victim] += 1;
  const forged = lines.map(line => line.includes('"kind":"watermark"')
    ? JSON.stringify({ ...JSON.parse(line), tables }) : line).join("\n") + "\n";
  const target = openStore(t, "restore-ndjson-tables-");
  assert.throws(() => replayNdjsonInto(forged, target), new RegExp(`watermark.*${victim}`, "i"));
  assert.ok(!target.db.prepare("SELECT 1 FROM rooms LIMIT 1").get(), "failed replay leaves the store empty");
});

test("an export naming a table the store does not have is rejected", t => {
  const { ndjson } = seed(t);
  const forged = ndjson + JSON.stringify({ table: "nope_not_a_table", row: { id: 1 } }) + "\n";
  const target = openStore(t, "restore-ndjson-forged-");
  assert.throws(() => replayNdjsonInto(forged, target), /does not have/);
});

test("malformed NDJSON and a bad watermark are rejected", t => {
  const target = openStore(t, "restore-ndjson-malformed-");
  assert.throws(() => replayNdjsonInto("not json\n", target), /not JSON|empty/i);
  assert.throws(() => replayNdjsonInto("", target), /empty/i);
  const { ndjson } = seed(t);
  const badVersion = ndjson.replace('"version":1', '"version":2');
  assert.throws(() => replayNdjsonInto(badVersion, target), /watermark/i);
});

test("operator restore stays closed until the backup token is set, then enforces auth and method", async t => {
  const { ndjson } = seed(t);
  const target = openStore(t, "restore-ndjson-gate-");
  let response = await operatorRestoreResponse(fakeRequest({ body: ndjson }), undefined, target);
  assert.equal(response.status, 404, "unconfigured token answers 404 like the export endpoint");
  response = await operatorRestoreResponse(fakeRequest({ body: ndjson, token: "wrong-token-value-here" }), OPERATOR_TOKEN, target);
  assert.equal(response.status, 401);
  response = await operatorRestoreResponse(fakeRequest({ method: "GET", body: ndjson }), OPERATOR_TOKEN, target);
  assert.equal(response.status, 405);
  assert.ok(!target.db.prepare("SELECT 1 FROM rooms LIMIT 1").get(), "denied attempts write nothing");
});

test("operator restore refuses a live store and oversized bodies", async t => {
  const { ndjson, store } = seed(t);
  const response = await operatorRestoreResponse(fakeRequest({ body: ndjson }), OPERATOR_TOKEN, store);
  assert.equal(response.status, 409, "restore into a non-empty store is a conflict, never an overwrite");
  const target = openStore(t, "restore-ndjson-413-");
  const tooBig = await operatorRestoreResponse(
    fakeRequest({ body: "x".repeat(10), contentLength: 64 * 1024 * 1024 + 1 }), OPERATOR_TOKEN, target);
  assert.equal(tooBig.status, 413);
});

test("operator restore replays a valid export and reports the verified summary", async t => {
  const { ndjson, store: seeded } = seed(t);
  const events = seeded.db.prepare("SELECT count(*) AS n FROM events").get().n;
  const target = openStore(t, "restore-ndjson-ok-");
  const response = await operatorRestoreResponse(fakeRequest({ body: ndjson }), OPERATOR_TOKEN, target);
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.verified, true);
  assert.equal(summary.events, events);
  assert.match(summary.note ?? "", /credential/i, "summary warns that secrets do not survive the export");
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM events").get().n, events);
});

test("operator restore rejects a malformed export with 422 and leaves the store empty", async t => {
  const target = openStore(t, "restore-ndjson-422-");
  const response = await operatorRestoreResponse(fakeRequest({ body: "garbage\n" }), OPERATOR_TOKEN, target);
  assert.equal(response.status, 422);
  assert.ok(!target.db.prepare("SELECT 1 FROM rooms LIMIT 1").get(), "failed restore leaves the store empty");
});
