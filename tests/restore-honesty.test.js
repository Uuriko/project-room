// HUNT-RESTORE charters R-1/R-2/R-4/R-5 (drills in
// ~/workspace/hunt-scratch/restore/): a truncated or money-mutilated
// export must not restore as an unqualified `verified: true`.
//
// The exporter now writes per-table row counts into the watermark
// (watermark.tables); every restore path verifies them plus the
// watermark's per-room sequences against the restored store, runs
// verifyConservation before declaring success, and the file-replay
// script surfaces the full verification result and refuses to report
// success below "full". Each test below is one drill shape; each fails
// on the pre-fix code (where the exporter wrote no counts, no path
// checked sequences or conservation, and the file parser died on
// Cloudflare-internal tables).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { progressEscrowEpochs } from "../server/bounty-epoch-keeper.mjs";
import { exportNdjsonText, replayNdjson } from "../server/room-export.mjs";
import { replayNdjsonInto, createBackupReplaySession } from "../server/restore-ndjson.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const DAY = 24 * 3600 * 1000;
const SEED_NOW = 1_786_000_000_000;
const SCRIPT = fileURLToPath(new URL("../scripts/replay-room-export.mjs", import.meta.url));

function makeDir(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function openTarget(t, directory, name) {
  const store = new RoomStore(join(directory, name));
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  return store;
}

// A store with history and money: 4 messages, and three bounties — one
// funded, one claimed, one accepted and paid by the epoch keeper — over a
// genesis endowment whose conservation verifies at the source.
function seedStore(t, directory) {
  const file = join(directory, "seed.sqlite");
  const store = new RoomStore(file);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (key, type, data) => store.command(key, "commons", { id: randomUUID(), type, data });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "worker", displayName: "Worker", kind: "agent", permissions: ["accept_work", "verify", "write_external", "complete_work"] });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "reviewer", displayName: "Reviewer", kind: "agent", permissions: ["verify"] });
  for (let i = 0; i < 4; i++) cmd(ownerKey, T.MESSAGE_POSTED, { messageId: randomUUID(), body: `history message ${i + 1}` });
  let nowMs = SEED_NOW;
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  escrow.ensureGenesis("commons");
  const post = amount => escrow.postBounty("commons", { poster: "owner", title: "T", criteria: "C", amount, deadline: new Date(nowMs + 30 * DAY).toISOString(), verifierId: "reviewer" }).bounty;
  const funded = post(10);
  escrow.fundBounty("commons", funded.bountyId, { funder: "owner" });
  const claimed = post(10);
  escrow.fundBounty("commons", claimed.bountyId, { funder: "owner" });
  escrow.claimBounty("commons", claimed.bountyId, { claimant: "worker" });
  const paid = post(10);
  escrow.fundBounty("commons", paid.bountyId, { funder: "owner" });
  escrow.claimBounty("commons", paid.bountyId, { claimant: "worker" });
  escrow.submitWork("commons", paid.bountyId, { claimant: "worker", evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did it" } });
  escrow.acceptWork("commons", paid.bountyId, { acceptor: "owner", verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  nowMs += 4 * DAY;
  progressEscrowEpochs(store, { now: nowMs, escrow });
  progressEscrowEpochs(store, { now: nowMs, escrow });
  assert.equal(escrow.getBounty("commons", paid.bountyId).state, "paid", "seed's third bounty settles to paid");
  assert.equal(escrow.verifyConservation("commons").ok, true, "seed conserves");
  return { store, file, paidId: paid.bountyId };
}

const linesOf = text => text.trim().split("\n");
const recordsOf = text => linesOf(text).map(line => JSON.parse(line));

test("a full export carries watermark.tables and restores verified/full with conservation ok on every path", t => {
  const directory = makeDir(t, "restore-honesty-happy-");
  const { store } = seedStore(t, directory);
  const ndjson = exportNdjsonText(store.db);
  const records = recordsOf(ndjson);
  const watermark = records.find(record => record.kind === "watermark");
  assert.ok(watermark.tables, "exporter writes per-table watermark counts");
  const lineCounts = {};
  for (const record of records) if (record.table) lineCounts[record.table] = (lineCounts[record.table] ?? 0) + 1;
  for (const [table, expected] of Object.entries(watermark.tables))
    assert.equal(expected, lineCounts[table], `watermark count for ${table} matches the dumped rows`);
  assert.equal(watermark.tables.messages, 4);
  assert.equal(watermark.tables.bounty_records, 3);

  const fileResult = replayNdjson(ndjson, join(directory, "file.sqlite"));
  assert.equal(fileResult.verified, true);
  assert.equal(fileResult.contentVerification, "full");
  assert.equal(typeof fileResult.backedUpAt, "number", "file replay result names the backup's as-of time");
  assert.deepEqual(fileResult.conservation, { ok: true, violations: [] });

  const intoResult = replayNdjsonInto(ndjson, openTarget(t, directory, "into.sqlite"));
  assert.equal(intoResult.verified, true);
  assert.equal(intoResult.contentVerification, "full");
  assert.deepEqual(intoResult.conservation, { ok: true, violations: [] });

  const sessionTarget = openTarget(t, directory, "session.sqlite");
  const session = createBackupReplaySession(sessionTarget);
  session.writeText(ndjson);
  const sessionResult = session.finish();
  assert.equal(sessionResult.verified, true);
  assert.equal(sessionResult.contentVerification, "full");
  assert.deepEqual(sessionResult.conservation, { ok: true, violations: [] });
});

test("a 75%-cut export is refused on every path instead of restoring as verified (drill T1)", t => {
  const directory = makeDir(t, "restore-honesty-cut-");
  const { store } = seedStore(t, directory);
  const lines = linesOf(exportNdjsonText(store.db));
  const cut = lines.slice(0, Math.floor(lines.length * 0.75)).join("\n") + "\n";
  assert.throws(() => replayNdjson(cut, join(directory, "cut.sqlite")), /watermark does not match/);
  const intoTarget = openTarget(t, directory, "cut-into.sqlite");
  assert.throws(() => replayNdjsonInto(cut, intoTarget), /watermark does not match/);
  assert.ok(!intoTarget.db.prepare("SELECT 1 FROM rooms LIMIT 1").get(), "refused replay leaves the store empty");
  const sessionTarget = openTarget(t, directory, "cut-session.sqlite");
  const session = createBackupReplaySession(sessionTarget);
  session.writeText(cut);
  assert.throws(() => session.finish(), /watermark does not match/);
  assert.ok(!sessionTarget.db.prepare("SELECT 1 FROM rooms LIMIT 1").get(), "aborted session leaves the store empty");
});

test("a head-only prefix export is refused, naming the absent money and message tables (drill T2)", t => {
  const directory = makeDir(t, "restore-honesty-prefix-");
  const { store } = seedStore(t, directory);
  const kept = ["accounts", "rooms", "events", "commands"];
  const prefix = recordsOf(exportNdjsonText(store.db))
    .filter(record => record.kind === "watermark" || kept.includes(record.table))
    .map(record => JSON.stringify(record)).join("\n") + "\n";
  for (const attempt of [
    () => replayNdjson(prefix, join(directory, "prefix.sqlite")),
    () => replayNdjsonInto(prefix, openTarget(t, directory, "prefix-into.sqlite"))
  ]) {
    assert.throws(attempt, error => /watermark does not match the restored tables/.test(error.message)
      && error.message.includes("bounty_records") && error.message.includes("messages"));
  }
});

test("a paid bounty stripped of its journal legs is refused, naming bounty_journal (drill T5b)", t => {
  const directory = makeDir(t, "restore-honesty-legs-");
  const { store, paidId } = seedStore(t, directory);
  const stripped = linesOf(exportNdjsonText(store.db)).filter(line => {
    const record = JSON.parse(line);
    if (record.kind === "trailer") return false;
    if (record.table === "bounty_journal" && JSON.stringify(record.row).includes(paidId)) return false;
    return true;
  }).join("\n") + "\n";
  assert.throws(() => replayNdjson(stripped, join(directory, "legs.sqlite")), /bounty_journal/);
  assert.throws(() => replayNdjsonInto(stripped, openTarget(t, directory, "legs-into.sqlite")), /bounty_journal/);
});

test("a falsified watermark room sequence is refused on the file and buffered paths (drill T6)", t => {
  const directory = makeDir(t, "restore-honesty-seq-");
  const { store } = seedStore(t, directory);
  const forged = recordsOf(exportNdjsonText(store.db)).map(record => record.kind === "watermark"
    ? { ...record, rooms: record.rooms.map(room => ({ ...room, sequence: room.sequence + 1000 })) }
    : record).map(record => JSON.stringify(record)).join("\n") + "\n";
  assert.throws(() => replayNdjson(forged, join(directory, "seq.sqlite")), /room sequences/);
  assert.throws(() => replayNdjsonInto(forged, openTarget(t, directory, "seq-into.sqlite")), /room sequences/);
});

test("an export of a journal-mutilated store: strict restore refuses on conservation, report mode names the violations (drill T3)", t => {
  const directory = makeDir(t, "restore-honesty-mutilated-");
  const { store, file } = seedStore(t, directory);
  try { store.close(); } catch { /* already closed */ }
  const mutilatedFile = join(directory, "mutilated.sqlite");
  copyFileSync(file, mutilatedFile);
  const db = new DatabaseSync(mutilatedFile);
  const total = db.prepare("SELECT count(*) AS n FROM bounty_journal").get().n;
  db.prepare("DELETE FROM bounty_journal WHERE rowid IN (SELECT rowid FROM bounty_journal ORDER BY rowid LIMIT ?)")
    .run(Math.floor(total / 4));
  // The mutilated store exports and re-pins cleanly: only conservation
  // can see that its money no longer adds up.
  const text = exportNdjsonText(db);
  db.close();
  assert.throws(() => replayNdjson(text, join(directory, "t3-strict.sqlite")), /conservation/i);
  const reported = replayNdjson(text, join(directory, "t3-report.sqlite"), { audit: "report" });
  assert.equal(reported.verified, true);
  assert.equal(reported.conservation.ok, false);
  assert.ok(reported.conservation.violations.length > 0, "report mode names the conservation violations");
  assert.ok(reported.conservation.violations.every(v => typeof v.roomId === "string" && typeof v.violation === "string"));
  const intoReported = replayNdjsonInto(text, openTarget(t, directory, "t3-into.sqlite"), { audit: "report" });
  assert.equal(intoReported.conservation.ok, false);
  assert.ok(intoReported.conservation.violations.length > 0);
});

test("file replay skips Cloudflare-internal tables and reports them, like the DO paths (drill 5, F4)", t => {
  const directory = makeDir(t, "restore-honesty-cf-");
  const { store, file } = seedStore(t, directory);
  try { store.close(); } catch { /* already closed */ }
  const withCfFile = join(directory, "with-cf.sqlite");
  copyFileSync(file, withCfFile);
  const db = new DatabaseSync(withCfFile);
  db.exec("CREATE TABLE _cf_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO _cf_kv VALUES ('internal','state')").run();
  const text = exportNdjsonText(db);
  db.close();
  const result = replayNdjson(text, join(directory, "cf-restored.sqlite"));
  assert.equal(result.verified, true);
  assert.equal(result.skippedTables._cf_kv, 1);
});

function runScript(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

test("the file-replay script surfaces the full result and refuses to report success below full verification", t => {
  const directory = makeDir(t, "restore-honesty-script-");
  const { store } = seedStore(t, directory);
  const ndjson = exportNdjsonText(store.db);
  const from = join(directory, "export.ndjson");
  writeFileSync(from, ndjson);
  let run = runScript(["--from", from, "--to", join(directory, "ok.sqlite")]);
  assert.equal(run.code, 0, run.stderr);
  let printed = JSON.parse(run.stdout);
  assert.equal(printed.verified, true);
  assert.equal(printed.contentVerification, "full");
  assert.equal(typeof printed.backedUpAt, "string", "script prints the backup's as-of time");
  assert.deepEqual(printed.conservation, { ok: true, violations: [] });

  // Trailer removed, data complete: the library restores at
  // "watermark-only", and the script must not call that success.
  const partial = linesOf(ndjson).filter(line => JSON.parse(line).kind !== "trailer").join("\n") + "\n";
  const fromPartial = join(directory, "partial.ndjson");
  writeFileSync(fromPartial, partial);
  run = runScript(["--from", fromPartial, "--to", join(directory, "partial.sqlite")]);
  assert.equal(run.code, 1, "below-full restore is not reported as success");
  printed = JSON.parse(run.stdout);
  assert.equal(printed.contentVerification, "watermark-only");
  assert.match(run.stderr, /--allow-partial/);
  run = runScript(["--from", fromPartial, "--to", join(directory, "partial-ok.sqlite"), "--allow-partial"]);
  assert.equal(run.code, 0, run.stderr);
});
