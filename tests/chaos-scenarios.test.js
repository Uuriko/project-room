// HT-6 (task 166): chaos scenarios for the room — the gaps left by
// tests/chaos-drill.test.js (F024), which covers only the kill-DO-mid-write
// family. Every scenario here injects a real fault against real production
// code (node:sqlite, RoomStore, scripts/room, scripts/replay-room-export.mjs,
// scripts/backup-verify.mjs, createRoomServer) and asserts the system either
// recovers or fails LOUDLY — never silently corrupt, never a torn artifact
// reported as healthy.
//
// Test-audit gate answers (one per scenario, summarized): each guards a
// contract at its owning boundary that F024 and the existing suites do not
// reach (node-sqlite path vs DO path, board-file integrity, export replay,
// backup IO, credential expiry, HTTP-layer abort). The credible regression
// for each is a "simplification" that drops the guard (skip the integrity
// check, swallow the replay mismatch, catch-and-ignore the backup throw,
// downgrade an expired key to guest). No test-only production seams are
// added; fixtures are built from production code (exportNdjsonText) or the
// documented ROOM-STATE.md generator contract.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { createRoomServer } from "../server/http.mjs";
import { backupRoom } from "../server/backup.mjs";
import { exportNdjsonText } from "../server/room-export.mjs";
import { parseSchedule, runBackupCycle } from "../scripts/backup-verify.mjs";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const ROOM = "commons";

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function liveRoom(t, prefix = "chaos-") {
  const dir = tempDir(t, prefix);
  const file = join(dir, "room.sqlite");
  const store = new RoomStore(file);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  return { dir, file, store, ownerKey };
}

const post = (store, key, body) =>
  store.command(key, ROOM, { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body } });

// ---------------------------------------------------------------------------
// 1. Kill the node/sqlite DB mid-write: uncommitted work must vanish, the
//    committed baseline must survive, and the store must reopen cleanly.
//    (F024 covers the Durable Object path; this is the node:sqlite path.)
// ---------------------------------------------------------------------------
test("chaos: kill node-sqlite mid-write loses only the uncommitted journal", t => {
  const { file, store, ownerKey } = liveRoom(t, "chaos-kill-");
  post(store, ownerKey, "committed baseline");
  const seqBefore = store.room(ROOM).sequence;

  // Simulate process death on the store's own connection (which carries the
  // writer-fence function): BEGIN, one partial write, close with NO commit.
  store.db.exec("BEGIN IMMEDIATE");
  store.db.exec(`INSERT INTO events(room_id, sequence, id, body) VALUES('commons', ${seqBefore + 1}, '${randomUUID()}', '{}')`);
  store.close(); // no COMMIT — the journal is abandoned like a killed process

  const reopened = new RoomStore(file);
  t.after(() => reopened.close());
  assert.equal(reopened.room(ROOM).sequence, seqBefore,
    "the uncommitted partial write is gone after the kill");
  const bodies = reopened.room(ROOM).state.messages.map(m => m.body).join("\n");
  assert.ok(bodies.includes("committed baseline"), "baseline message survived the kill");

  // The store is fully functional after the kill: writes commit cleanly.
  const key2 = reopened.issueAccessKey(ROOM, "owner");
  post(reopened, key2, "after kill");
  assert.equal(reopened.room(ROOM).sequence, seqBefore + 1);
});

// ---------------------------------------------------------------------------
// 2. Backup racing a write burst: the sqlite online-backup API must yield a
//    consistent snapshot (verified) or fail loudly — never a torn backup
//    reported as healthy.
// ---------------------------------------------------------------------------
test("chaos: backup under a write burst stays consistent or fails loudly", async t => {
  const { file, store, ownerKey } = liveRoom(t, "chaos-race-");
  post(store, ownerKey, "race baseline");
  const baselineEvents = store.db.prepare("SELECT count(*) AS n FROM events").get().n;
  const dest = tempDir(t, "chaos-race-dest-");

  const burst = (async () => {
    for (let i = 0; i < 25; i++) {
      post(store, ownerKey, `race write ${i}`);
      await sleep(0); // let the backup interleave at its await points
    }
  })();
  const result = await Promise.allSettled([backupRoom(file, dest), burst]).then(([r]) => r);

  if (result.status === "rejected") {
    assert.match(String(result.reason?.message ?? result.reason), /./,
      "a backup that cannot stay consistent fails loudly, not silently");
    return;
  }
  assert.equal(result.value.verified, true, "racing backup verifies");
  const watermark = JSON.parse(
    (await import("node:fs")).readFileSync(result.value.watermark, "utf8"));
  assert.ok(watermark.events >= baselineEvents && watermark.events <= baselineEvents + 25,
    `watermark event count is a sane snapshot, got ${watermark.events}`);
  // The snapshot actually opens as a room: no torn artifact.
  const snap = new RoomStore(result.value.filename, { readOnly: true });
  t.after(() => snap.close());
  assert.ok(snap.room(ROOM).sequence >= 1);
});

// ---------------------------------------------------------------------------
// 3-5. Board-file integrity: scripts/room query must die loudly on a
//    truncated or hand-edited ROOM-STATE.md, and succeed on a valid one.
//    Fixture follows the generator contract (scripts/room ~line 1972):
//    banner carries `integrity: sha256=<hex>` over the canonical RC- rows.
// ---------------------------------------------------------------------------
function boardFixture(rows) {
  const canon = rows.join("\n") + "\n";
  const hex = createHash("sha256").update(canon).digest("hex");
  return [
    "# ROOM-STATE — machine board",
    `<!-- generated: 2026-10-07T12:00:00Z · board: chaos-fixture · watermark: 0 · by: scripts/room rebuild · do-not-hand-edit · integrity: sha256=${hex} -->`,
    "",
    "## open",
    "task-id | lane | state | lease-expires-utc | files",
    ...rows,
    "",
    "## expiring-soon",
    "(none)",
    "",
  ].join("\n");
}

const BOARD_ROWS = [
  "RC-2026-10-07-001 | lane-a | claimed | 2026-10-08T00:00:00Z | server/a.mjs",
  "RC-2026-10-07-002 | lane-b | submitted | 2026-10-08T00:00:00Z | docs/b.md",
];

function roomQuery(statePath) {
  return spawnSync("bash", [join(checkout, "scripts", "room"), "query", "--state", statePath],
    { encoding: "utf8", cwd: checkout, timeout: 30000 });
}

test("chaos: query on a valid board file succeeds (positive control)", t => {
  const dir = tempDir(t, "chaos-board-");
  const f = join(dir, "ROOM-STATE.md");
  writeFileSync(f, boardFixture(BOARD_ROWS));
  const r = roomQuery(f);
  assert.equal(r.status, 0, `valid board must query cleanly: ${r.stderr}`);
  assert.match(r.stdout, /RC-2026-10-07-001/);
});

test("chaos: truncated board file fails loudly, never serves partial rows", t => {
  const dir = tempDir(t, "chaos-board-");
  const f = join(dir, "ROOM-STATE.md");
  // Truncation: keep the ORIGINAL banner marker (over both rows) but drop the
  // second row — exactly what a truncated download looks like.
  const canon = BOARD_ROWS.join("\n") + "\n";
  const hex = createHash("sha256").update(canon).digest("hex");
  const text = [
    "# ROOM-STATE — machine board",
    `<!-- generated: 2026-10-07T12:00:00Z · board: chaos-fixture · watermark: 0 · by: scripts/room rebuild · do-not-hand-edit · integrity: sha256=${hex} -->`,
    "",
    "## open",
    "task-id | lane | state | lease-expires-utc | files",
    BOARD_ROWS[0],
    "",
    "## expiring-soon",
    "(none)",
    "",
  ].join("\n");
  writeFileSync(f, text);
  const r = roomQuery(f);
  assert.notEqual(r.status, 0, "truncated board must not query cleanly");
  assert.match(r.stderr, /integrity check failed/,
    "the failure names the integrity check, not a generic parse error");
});

test("chaos: hand-edited board file fails loudly", t => {
  const dir = tempDir(t, "chaos-board-");
  const f = join(dir, "ROOM-STATE.md");
  const edited = BOARD_ROWS.map(r => r.replace("lane-a", "lane-evil"));
  // Keep the ORIGINAL marker (as a hand-edit would): recompute nothing.
  const canon = BOARD_ROWS.join("\n") + "\n";
  const hex = createHash("sha256").update(canon).digest("hex");
  const text = [
    "# ROOM-STATE — machine board",
    `<!-- generated: 2026-10-07T12:00:00Z · board: chaos-fixture · watermark: 0 · by: scripts/room rebuild · do-not-hand-edit · integrity: sha256=${hex} -->`,
    "",
    "## open",
    "task-id | lane | state | lease-expires-utc | files",
    ...edited,
    "",
    "## expiring-soon",
    "(none)",
    "",
  ].join("\n");
  writeFileSync(f, text);
  const r = roomQuery(f);
  assert.notEqual(r.status, 0, "hand-edited board must not query cleanly");
  assert.match(r.stderr, /integrity check failed/);
  assert.match(r.stderr, /rebuild it with scripts\/room rebuild/);
});

// ---------------------------------------------------------------------------
// 6-7. Export replay: a truncated NDJSON export must fail verification
//    loudly and leave the destination unpromoted; a valid one replays.
// ---------------------------------------------------------------------------
test("chaos: replay of a valid export succeeds (positive control)", t => {
  const { store } = liveRoom(t, "chaos-export-");
  const key = store.issueAccessKey(ROOM, "owner");
  post(store, key, "export me");
  const dir = tempDir(t, "chaos-export-");
  const src = join(dir, "export.ndjson");
  writeFileSync(src, exportNdjsonText(store.db));
  const dest = join(dir, "restored.sqlite");
  const r = spawnSync(process.execPath, [join(checkout, "scripts", "replay-room-export.mjs"),
    "--from", src, "--to", dest], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, `valid export must replay: ${r.stderr}`);
  assert.match(r.stdout, /"verified":true/);
  assert.ok(existsSync(dest), "destination promoted on success");
});

test("chaos: truncated export fails loudly and the destination is not promoted", t => {
  const { store } = liveRoom(t, "chaos-export-");
  const key = store.issueAccessKey(ROOM, "owner");
  for (let i = 0; i < 5; i++) post(store, key, `export line ${i}`);
  const dir = tempDir(t, "chaos-export-");
  const lines = exportNdjsonText(store.db).trimEnd().split("\n");
  assert.ok(lines.length > 4, "fixture needs several lines to truncate");
  const truncated = join(dir, "truncated.ndjson");
  writeFileSync(truncated, lines.slice(0, -3).join("\n") + "\n");
  const dest = join(dir, "restored.sqlite");
  const r = spawnSync(process.execPath, [join(checkout, "scripts", "replay-room-export.mjs"),
    "--from", truncated, "--to", dest], { encoding: "utf8", timeout: 60000 });
  assert.notEqual(r.status, 0, "truncated export must not replay cleanly");
  assert.match(r.stderr, /Replay failed verification/,
    "the failure says verification failed, and names the unpromoted destination");
  assert.equal(existsSync(dest), false, "destination is NOT promoted on failure");
});

// ---------------------------------------------------------------------------
// 8. Backup to an unusable destination: the cycle throws loudly — it never
//    reports ok:true with no backup written.
// ---------------------------------------------------------------------------
test("chaos: backup cycle to a non-directory destination fails loudly", async t => {
  const { file } = liveRoom(t, "chaos-backup-");
  const dir = tempDir(t, "chaos-backup-");
  const notADir = join(dir, "not-a-dir");
  writeFileSync(notADir, "i am a file, not a directory");
  await assert.rejects(
    runBackupCycle({ db: file, to: notADir, statePath: join(dir, "state.json"),
      schedule: parseSchedule("hourly"), force: true, nowMs: Date.now() }),
    /EEXIST|Backup requires an existing database/,
    "unusable destination throws loudly instead of reporting ok:true");
});

// ---------------------------------------------------------------------------
// 9. Expired credential: fails closed with 401 — never silently downgraded
//    to a lesser identity, and the room stays usable with a fresh key.
// ---------------------------------------------------------------------------
test("chaos: expired access key fails closed; fresh key still works", async t => {
  const { store, ownerKey } = liveRoom(t, "chaos-expiry-");
  const seqBefore = store.room(ROOM).sequence;
  const shortKey = store.issueAccessKey(ROOM, "owner", 5); // 5 ms lifetime; revokes ownerKey by design
  await sleep(30);
  assert.throws(
    () => post(store, shortKey, "with an expired key"),
    err => {
      assert.equal(err.status, 401);
      assert.equal(err.code, "unauthenticated");
      return true;
    },
    "expired key is rejected loudly");
  assert.equal(store.room(ROOM).sequence, seqBefore, "rejected write changed nothing");
  const freshKey = store.issueAccessKey(ROOM, "owner"); // rotation revokes the spent key
  post(store, freshKey, "with a fresh key");
  assert.equal(store.room(ROOM).sequence, seqBefore + 1, "room stays usable");
});

// ---------------------------------------------------------------------------
// 10. Client disconnect mid-request: the HTTP server survives, the store is
//     untouched, and the next request works.
// ---------------------------------------------------------------------------
test("chaos: aborted mid-request connection does not corrupt the server", async t => {
  const { store, ownerKey } = liveRoom(t, "chaos-abort-");
  const seqBefore = store.room(ROOM).sequence;
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const stop = async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  try {
    await new Promise((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () => {
        // A POST that never finishes: headers promise a body that never comes.
        sock.write("POST /api/rooms/commons/commands HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\nContent-Length: 500\r\nContent-Type: application/json\r\n\r\n" +
          '{"id":"');
        setTimeout(() => { sock.destroy(); resolve(); }, 80);
      });
      sock.once("error", () => resolve()); // destroy races are fine
      setTimeout(() => reject(new Error("socket setup timed out")), 5000);
    });
    await sleep(150); // let the server notice the dead socket
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200, "server still answers after the abort");
    assert.equal(store.room(ROOM).sequence, seqBefore,
      "the aborted request left no partial state");
    post(store, ownerKey, "after abort");
    assert.equal(store.room(ROOM).sequence, seqBefore + 1);
  } finally {
    await stop();
  }
});
