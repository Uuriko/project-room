// #3324: the claim-permit parity of the open-store restore must hold on
// the KV streaming path (createBackupReplaySession, behind
// POST /api/operator/restore-from-backup) exactly as it does in the
// buffered replayNdjsonInto — the tests in tests/restore-ndjson.test.js
// own the buffered path; these own the path a production disaster
// recovery actually takes (#3409). A production-shaped backup carries
// public-namespace claims, and an export carrying an enabled=1 writer
// permit must never import that authority.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonStream, exportNdjsonText } from "../server/room-export.mjs";
import { operatorRestoreFromBackupResponse } from "../server/restore-ndjson.mjs";
import { writeKvBackup } from "../cloudflare/room-backup.mjs";
import { withPublicWorkClaimWriter } from "../server/public-work-claim-fence.mjs";
import { createWork } from "../server/work-claims.mjs";

const OPERATOR_TOKEN = "<MASKED_SECRET_003>";
const KEY = "room-backups/2026-10-14.ndjson";
const NAMESPACE = `public_${"ef".repeat(16)}`;

function openStoreAt(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  const path = join(directory, "room.sqlite");
  const store = new RoomStore(path);
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { store, path };
}

function seedPublic(t) {
  const { store } = openStoreAt(t, "restore-permit-kv-seed-");
  store.initialize(initialRoom(NAMESPACE));
  const now = Date.now();
  store.db.prepare(`INSERT INTO public_work_tasks
      (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run("offer-1", NAMESPACE, NAMESPACE, 1, "https://github.com/Uuriko/project-room", "main", JSON.stringify(["README.md"]), 1, now);
  // Claim writes in a public namespace go through the permit machinery;
  // seed the claim the same way production writes it.
  withPublicWorkClaimWriter(store, () => store.workClaims.set(NAMESPACE,
    createWork({ id: "pub-claim", title: "Public task", repo: "Uuriko/project-room" }, now)));
  return store;
}

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, typeof value === "string" ? value : Buffer.from(value)); },
    async delete(key) { map.delete(key); },
  };
}

function fakeRequest(key) {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${OPERATOR_TOKEN}`);
  return { method: "POST", url: `https://room.example/api/operator/restore-from-backup?key=${encodeURIComponent(key)}`, headers, text: async () => "" };
}

test("restore-from-backup restores an export carrying public-namespace claims (#3324)", async t => {
  const seeded = seedPublic(t);
  const kv = fakeKv();
  await writeKvBackup(kv, KEY, exportNdjsonStream(seeded.db), { partBytes: 2048 });
  const { store: target } = openStoreAt(t, "restore-permit-kv-target-");
  const response = await operatorRestoreFromBackupResponse(fakeRequest(KEY), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verified, true);
  const claim = target.workClaims.get(NAMESPACE, "pub-claim");
  assert.ok(claim, "the public claim row restored through the streaming replay");
  assert.equal((claim.data ?? claim).state, "unclaimed");
  const permit = target.db.prepare("SELECT enabled FROM public_work_claim_writer_permit WHERE singleton=1").get();
  assert.equal(permit.enabled, 0, "the target permit is closed at rest after the restore");
});

test("restore-from-backup never imports a doctored enabled=1 writer permit (#3324)", async t => {
  const seeded = seedPublic(t);
  // The export carries the source's own (closed) permit row; doctor it open.
  const doctored = exportNdjsonText(seeded.db).split("\n").map(line => line.includes('"table":"public_work_claim_writer_permit"')
    ? line.replace('"enabled":0', '"enabled":1') : line).join("\n");
  assert.match(doctored, /"table":"public_work_claim_writer_permit".*"enabled":1/, "the fixture really carries an open permit");
  const kv = fakeKv();
  await writeKvBackup(kv, KEY, doctored, { partBytes: 2048 });
  const { store: target, path } = openStoreAt(t, "restore-permit-kv-doctored-");
  const response = await operatorRestoreFromBackupResponse(fakeRequest(KEY), OPERATOR_TOKEN, target, kv);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.verified, true);
  assert.equal(payload.skippedTables["public_work_claim_writer_permit"], 1, "the exported permit row is reported as skipped");
  assert.equal(target.db.prepare("SELECT enabled FROM public_work_claim_writer_permit WHERE singleton=1").get().enabled, 0);
  target.close();
  // Reopening runs the closed-at-rest fence verification; an imported open
  // permit would throw here and brick the restored store.
  const reopened = new RoomStore(path);
  t.after(() => { try { reopened.close(); } catch { /* already closed */ } });
  assert.ok(reopened.room(NAMESPACE), "the restored store reopens with the fence closed");
});
