// SECURITY-FIX C4 (HUNT-ADVERSARY P4) — the backup-token operator doors
// (export / restore / restore-from-backup) meet the purge surface's
// standard: a >=32-char credential floor, denied indistinguishable from
// unconfigured (plain 404, no 401 oracle), a per-address rate limit, and
// an operator_actions audit row for every use.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonText, operatorExportResponse, auditOperatorDoor } from "../server/room-export.mjs";
import { operatorRestoreResponse } from "../server/restore-ndjson.mjs";
import { listOperatorActions } from "../server/operator-actions.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const TOKEN = "backup-door-token-0123456789abcdef01"; // 36 chars, over the floor
const TOKEN_32 = "exactly-thirty-two-characters-01"; // exactly 32
const TOKEN_31 = "thirty-one-characters-token-012"; // exactly 31, under the floor

function openStore(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seededStore(t) {
  const store = openStore(t, "backup-doors-seed-");
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "history the audit test restores" } });
  return store;
}

const exportReq = (token, headers = {}) => new Request("https://room.example/api/operator/export", {
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
});

function restoreReq({ body = "", token = TOKEN } = {}) {
  const headers = new Headers({ "content-type": "application/x-ndjson" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return { method: "POST", url: "https://room.example/api/operator/restore", headers, text: async () => body };
}

test("C4 floor: a configured backup token under 32 chars reads as unconfigured", async t => {
  const store = seededStore(t);
  assert.equal(TOKEN_31.length, 31);
  assert.equal(TOKEN_32.length, 32);
  // Even presenting the exact 31-char value cannot open the door.
  const under = operatorExportResponse(exportReq(TOKEN_31), TOKEN_31, store.db, store);
  assert.equal(under.status, 404);
  const restoreUnder = await operatorRestoreResponse(restoreReq({ token: TOKEN_31 }), TOKEN_31, store);
  assert.equal(restoreUnder.status, 404);
  // Exactly 32 chars is a working credential.
  const ok = operatorExportResponse(exportReq(TOKEN_32), TOKEN_32, store.db, store);
  assert.equal(ok.status, 200);
});

test("C4 no oracle: denied and unconfigured answers are byte-identical", async t => {
  const store = seededStore(t);
  const denied = operatorExportResponse(exportReq("a-wrong-token-that-is-long-enough-0123"), TOKEN, store.db, store);
  const unconfigured = operatorExportResponse(exportReq("a-wrong-token-that-is-long-enough-0123"), undefined, store.db, store);
  assert.equal(denied.status, 404);
  assert.equal(unconfigured.status, 404);
  assert.equal(await denied.text(), await unconfigured.text());
  assert.equal(denied.headers.get("content-type"), unconfigured.headers.get("content-type"));

  const source = seededStore(t);
  const ndjson = exportNdjsonText(source.db);
  const target = openStore(t, "backup-doors-oracle-");
  const deniedRestore = await operatorRestoreResponse(restoreReq({ body: ndjson, token: "a-wrong-token-that-is-long-enough-0123" }), TOKEN, target);
  const unconfiguredRestore = await operatorRestoreResponse(restoreReq({ body: ndjson }), undefined, target);
  assert.equal(deniedRestore.status, 404);
  assert.equal(unconfiguredRestore.status, 404);
  assert.equal(await deniedRestore.text(), await unconfiguredRestore.text());
});

test("C4 rate limit: the eleventh request from one address in a minute is 429", async t => {
  const store = seededStore(t);
  for (let i = 0; i < 10; i++) {
    assert.equal(operatorExportResponse(exportReq(TOKEN), TOKEN, store.db, store).status, 200, `request ${i + 1} passes`);
  }
  const limited = operatorExportResponse(exportReq(TOKEN), TOKEN, store.db, store);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "rate_limited");
  // A different source address has its own bucket.
  const other = operatorExportResponse(exportReq(TOKEN, { "cf-connecting-ip": "192.0.2.99" }), TOKEN, store.db, store);
  assert.equal(other.status, 200);
});

test("C4 audit: export success and denial both leave operator_actions rows", async t => {
  const store = seededStore(t);
  assert.equal(operatorExportResponse(exportReq(TOKEN), TOKEN, store.db, store).status, 200);
  assert.equal(operatorExportResponse(exportReq("a-wrong-token-that-is-long-enough-0123"), TOKEN, store.db, store).status, 404);
  const rows = listOperatorActions(store, 10).filter(row => row.action === "backup_export");
  assert.deepEqual(rows.map(row => row.result).sort(), ["denied", "success"]);
});

test("C4 audit: restore success records counts; denial records the attempt", async t => {
  const source = seededStore(t);
  const ndjson = exportNdjsonText(source.db);
  const target = openStore(t, "backup-doors-audit-");
  const ok = await operatorRestoreResponse(restoreReq({ body: ndjson }), TOKEN, target);
  assert.equal(ok.status, 200);
  const success = listOperatorActions(target, 10).find(row => row.action === "backup_restore");
  assert.equal(success.result, "success");
  assert.ok(success.counts.events >= 1, "counts carry the restored event total");

  const target2 = openStore(t, "backup-doors-audit2-");
  const denied = await operatorRestoreResponse(restoreReq({ body: ndjson, token: "a-wrong-token-that-is-long-enough-0123" }), TOKEN, target2);
  assert.equal(denied.status, 404);
  const deniedRow = listOperatorActions(target2, 10).find(row => row.action === "backup_restore");
  assert.equal(deniedRow.result, "denied");
  assert.ok(!target2.db.prepare("SELECT 1 FROM rooms LIMIT 1").get(), "denied restore wrote nothing");
});

test("C4 audit failure never blocks the door itself", async t => {
  const store = seededStore(t);
  // Break the audit sink: the export door itself never writes
  // operator_actions, so dropping the table makes ONLY the audit append
  // fail — the door must still answer (auditOperatorDoor logs loudly and
  // proceeds; a restore's counts ride the same wrapper).
  store.db.exec("DROP TABLE operator_actions");
  const ok = operatorExportResponse(exportReq(TOKEN), TOKEN, store.db, store);
  assert.equal(ok.status, 200);
  assert.match((await ok.text()), /"kind":/);

  // The wrapper itself: a store whose append path throws is swallowed.
  const broken = { db: null, now: () => Date.now(), transaction: () => { throw new Error("sink down"); } };
  assert.doesNotThrow(() => auditOperatorDoor(broken, { action: "backup_restore", result: "success" }));
});
