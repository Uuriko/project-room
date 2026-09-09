import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync, mkdirSync, rmSync, chmodSync, lstatSync, readdirSync,
  readFileSync, writeFileSync, symlinkSync, linkSync, unlinkSync, existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchJournal, MAX_ATTENTION } from "../client/watch-journal.mjs";

const at = Date.parse("2026-09-07T12:00:00Z");
const binding = Object.freeze({ version: 1, filter: "own-attention-v1", origin: "http://127.0.0.1:32123",
  roomId: "fixture-room", memberId: "fixture-member", accountId: "fixture-account", authEpoch: 0,
  createdEventId: "fixture-created" });
const checkpoint = (sequence = 2) => ({ sequence, eventId: `fixture-event-${sequence}` });
const notice = (id, signature = "accept", title = "Synthetic assignment") => [id, {
  signature: JSON.stringify([signature, "fixture-member", null, null, null, null, null]),
  payload: { roomId: binding.roomId, memberId: binding.memberId, workItemId: id, title,
    next: { action: signature, memberId: binding.memberId, workItemId: id, workRevision: 1, needsAttention: true,
      completionEventId: null, evidenceVersion: null }, notifyOnly: true,
    message: "Synthetic notification; no work is performed." }
}];
const notices = (...ids) => new Map(ids.map(id => notice(id)));

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), "room-watch-journal-"));
  const directory = join(parent, "private");
  const journals = [], cleanup = [];
  t.after(async () => {
    for (const finish of cleanup.reverse()) await finish();
    for (const journal of journals.reverse()) journal.close();
    rmSync(parent, { recursive: true, force: true });
  });
  return { parent, directory, onCleanup: finish => cleanup.push(finish), open(options) {
    const journal = new WatchJournal(directory, options); journals.push(journal); return journal;
  } };
}
function inspect(directory, fn) {
  const db = new DatabaseSync(join(directory, "watch.sqlite"));
  try { return fn(db); } finally { db.close(); }
}
function rows(directory) {
  return inspect(directory, db => Object.fromEntries(["checkpoint", "attention", "control"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(row => ({ ...row }))])));
}
const moduleUrl = new URL("../client/watch-journal.mjs", import.meta.url).href;
const probeSource = `
  import { WatchJournal } from ${JSON.stringify(moduleUrl)};
  let journal;
  try {
    journal = new WatchJournal(process.argv[1]);
    process.stdout.write(JSON.stringify({ acquired: true }) + '\\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ acquired: false, code: error.code }) + '\\n');
  } finally { journal?.close(); }
`;
function probe(directory) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probeSource, directory], { encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function holder(f) {
  const source = `
    import { WatchJournal } from ${JSON.stringify(moduleUrl)};
    const journal = new WatchJournal(process.argv[1]);
    process.send({ ready: true });
    process.on('message', message => {
      if (message === 'stop') { journal.close(); process.exitCode = 0; process.disconnect(); }
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, f.directory], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", value => { stderr += value; });
  const exited = once(child, "exit");
  f.onCleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const ready = await Promise.race([
    once(child, "message").then(([message]) => message),
    exited.then(() => { throw new Error(`Synthetic holder exited before ready: ${stderr}`); })
  ]);
  assert.equal(ready.ready, true);
  return { child, exited };
}
async function contender(f) {
  const source = `
    import { WatchJournal } from ${JSON.stringify(moduleUrl)};
    process.send({ ready: true });
    process.once('message', () => {
      try {
        const journal = new WatchJournal(process.argv[1]);
        process.send({ acquired: true });
        process.once('message', () => { journal.close(); process.disconnect(); });
      } catch (error) {
        process.send({ acquired: false, code: error.code }, () => process.disconnect());
      }
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, f.directory], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(child, "exit");
  f.onCleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  assert.deepEqual((await once(child, "message"))[0], { ready: true });
  const result = once(child, "message").then(([message]) => message);
  return { start() { child.send("start"); return result; } };
}

test("watcher journal creates only private local state and preserves exact pending IDs across restart", t => {
  const f = fixture(t), first = f.open();
  assert.equal(lstatSync(f.directory).mode & 0o077, 0);
  for (const file of ["ownership.sqlite", "watch.sqlite"]) {
    const stat = lstatSync(join(f.directory, file));
    assert.equal(stat.mode & 0o077, 0); assert.equal(stat.nlink, 1);
  }
  first.reconcile(binding, checkpoint(), notices("a"), at);
  const original = first.pending()[0];
  assert.equal(original.reason, "initial");
  first.close();
  const resumed = f.open();
  assert.deepEqual(resumed.pending(), [original], "unacknowledged committed notice survives restart exactly");
  resumed.reconcile(binding, checkpoint(3), notices("a"), at + 1000);
  assert.deepEqual(resumed.pending(), [original], "unchanged semantic request does not allocate a new ID");
  resumed.ack(original.id); assert.deepEqual(resumed.pending(), []);
  resumed.close();
  const acknowledged = f.open();
  acknowledged.reconcile(binding, checkpoint(4), notices("a"), at + 2000);
  assert.deepEqual(acknowledged.pending(), [], "acknowledged current attention remains deduplicated");
  acknowledged.reconcile(binding, checkpoint(5), new Map(), at + 3000);
  acknowledged.reconcile(binding, checkpoint(6), notices("a"), at + 4000);
  assert.notEqual(acknowledged.pending()[0].id, original.id, "an observed return is a new attention episode");
});

test("acknowledging an old ID cannot erase a replacement pending notice", t => {
  const f = fixture(t), journal = f.open();
  journal.reconcile(binding, checkpoint(), notices("a"), at);
  const old = journal.pending()[0];
  journal.reconcile(binding, checkpoint(3), new Map([notice("a", "verify")]), at + 1000);
  const replacement = journal.pending()[0];
  assert.notEqual(replacement.id, old.id);
  journal.ack(old.id); assert.deepEqual(journal.pending(), [replacement]);
  journal.ack(replacement.id); assert.deepEqual(journal.pending(), []);
});

test("capacity errors roll back pending replacement, deletion, and processing checkpoint together", t => {
  const f = fixture(t), journal = f.open();
  journal.reconcile(binding, checkpoint(), notices("a", "b"), at);
  const before = rows(f.directory);
  const tooLarge = new Map([notice("a", "verify"), notice("z", "accept", "x".repeat(8193))]);
  assert.throws(() => journal.reconcile(binding, checkpoint(3), tooLarge, at + 1000), { code: "attention_capacity" });
  assert.deepEqual(rows(f.directory), before);
  const tooMany = new Map(Array.from({ length: MAX_ATTENTION + 1 }, (_, index) => notice(`fixture-${index}`)));
  assert.throws(() => journal.reconcile(binding, checkpoint(3), tooMany, at + 1000), { code: "attention_capacity" });
  assert.deepEqual(rows(f.directory), before);
  const [id, oversizedSignature] = notice("a"); oversizedSignature.signature = "💥".repeat(1025);
  assert.throws(() => journal.reconcile(binding, checkpoint(3), new Map([[id, oversizedSignature]]), at + 1000), { code: "attention_capacity" });
  assert.deepEqual(rows(f.directory), before);
});

test("a failed final checkpoint write rolls back earlier attention changes and remains retryable", t => {
  const f = fixture(t), journal = f.open();
  journal.reconcile(binding, checkpoint(), notices("a", "b"), at);
  const before = rows(f.directory);
  inspect(f.directory, db => db.exec("CREATE TRIGGER synthetic_checkpoint_failure BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'synthetic checkpoint failure'); END"));
  assert.throws(() => journal.reconcile(binding, checkpoint(3), new Map([notice("a", "verify")]), at + 1000), /synthetic checkpoint failure/);
  assert.deepEqual(rows(f.directory), before);
  inspect(f.directory, db => db.exec("DROP TRIGGER synthetic_checkpoint_failure"));
  journal.reconcile(binding, checkpoint(3), new Map([notice("a", "verify")]), at + 1000);
  assert.equal(journal.state().sequence, 3); assert.equal(journal.pending().length, 1);
});

test("identity and history mismatches leave journal data unchanged", t => {
  const f = fixture(t), journal = f.open();
  journal.reconcile(binding, checkpoint(4), notices("a"), at);
  const before = rows(f.directory);
  for (const changed of [
    { ...binding, origin: "https://example.invalid" }, { ...binding, roomId: "other-room" },
    { ...binding, memberId: "other-member" }, { ...binding, accountId: "other-account" },
    { ...binding, authEpoch: 1 }, { ...binding, filter: "other-filter" }, { ...binding, createdEventId: "other-created" }
  ]) {
    assert.throws(() => journal.reconcile(changed, checkpoint(5), new Map(), at), { code: "identity_changed" });
    assert.deepEqual(rows(f.directory), before);
  }
  for (const changed of [checkpoint(3), { sequence: 4, eventId: "replacement-event" }]) {
    assert.throws(() => journal.reconcile(binding, changed, new Map(), at), { code: "history_changed" });
    assert.deepEqual(rows(f.directory), before);
  }
});

test("status and stop do not bootstrap missing directories or files", t => {
  const f = fixture(t);
  assert.throws(() => new WatchJournal(f.directory, { acquire: false }), { code: "ENOENT" });
  assert.equal(existsSync(f.directory), false);
  mkdirSync(f.directory, { mode: 0o700 });
  assert.throws(() => new WatchJournal(f.directory, { acquire: false }), { code: "ENOENT" });
  assert.deepEqual(readdirSync(f.directory), []);
});

test("status is non-mutating, stop preserves pending output, and a new run clears only its own stop state", t => {
  const f = fixture(t), journal = f.open();
  journal.reconcile(binding, checkpoint(), notices("a"), at);
  const pending = journal.pending(), observer = f.open({ acquire: false }), before = rows(f.directory);
  assert.equal(observer.status().state, "held"); assert.deepEqual(rows(f.directory), before);
  assert.throws(() => observer.reconcile(binding, checkpoint(3), new Map(), at), { code: "watcher_not_owner" });
  assert.throws(() => observer.ack(pending[0].id), { code: "watcher_not_owner" });
  assert.equal(observer.requestStop().state, "stop_requested"); assert.equal(journal.shouldStop(), true);
  assert.deepEqual(journal.pending(), pending);
  journal.close(); assert.equal(observer.status().state, "stopped");
  const stoppedRows = rows(f.directory); observer.requestStop(); assert.deepEqual(rows(f.directory), stoppedRows);
  const resumed = f.open(); assert.equal(resumed.shouldStop(), false); assert.deepEqual(resumed.pending(), pending);
});

test("record validation reads one snapshot while a holder commits a newer checkpoint and notice", t => {
  const f = fixture(t), journal = f.open();
  journal.reconcile(binding, checkpoint(), notices("a"), at);
  inspect(f.directory, db => assert.equal(db.prepare("PRAGMA journal_mode=WAL").get().journal_mode, "wal"));
  const prepare = DatabaseSync.prototype.prepare;
  let interleaved = false;
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    const statement = prepare.call(this, sql, ...rest);
    if (sql !== "SELECT body FROM checkpoint WHERE id=1" || interleaved) return statement;
    return { get: (...args) => {
      const row = statement.get(...args);
      interleaved = true;
      journal.reconcile(binding, checkpoint(3), new Map([notice("a", "verify")]), at + 1000);
      return row;
    } };
  };
  let observer;
  try { assert.doesNotThrow(() => { observer = f.open({ acquire: false }); }); }
  finally { DatabaseSync.prototype.prepare = prepare; }
  assert.equal(interleaved, true, "a newer coherent state committed between validation reads");
  assert.equal(observer.state().sequence, 3);
});

test("journal rejects permissive directories and symlink directory aliases", t => {
  const f = fixture(t);
  mkdirSync(f.directory, { mode: 0o755 }); chmodSync(f.directory, 0o755);
  assert.throws(() => f.open(), { code: "private_state_required" }); assert.deepEqual(readdirSync(f.directory), []);
  chmodSync(f.directory, 0o700);
  const alias = join(f.parent, "alias"); symlinkSync(f.directory, alias, "dir");
  assert.throws(() => new WatchJournal(alias), { code: "private_state_required" });
});

test("journal rejects permissive, hardlinked, symlinked state and sidecars without touching their targets", t => {
  const f = fixture(t); f.open().close();
  const state = join(f.directory, "watch.sqlite");
  chmodSync(state, 0o640);
  assert.throws(() => f.open(), { code: "private_state_required" }); chmodSync(state, 0o600);
  const hardlink = join(f.parent, "state-hardlink"); linkSync(state, hardlink);
  assert.throws(() => f.open(), { code: "private_state_required" }); unlinkSync(hardlink);
  const sentinel = join(f.parent, "sentinel"); writeFileSync(sentinel, "unchanged synthetic sentinel", { mode: 0o600 });
  const sidecar = state + "-journal"; symlinkSync(sentinel, sidecar);
  assert.throws(() => f.open(), { code: "private_state_required" }); assert.equal(readFileSync(sentinel, "utf8"), "unchanged synthetic sentinel");
  unlinkSync(sidecar);
  const saved = readFileSync(state); unlinkSync(state); symlinkSync(sentinel, state);
  assert.throws(() => f.open(), { code: "private_state_required" }); assert.equal(readFileSync(sentinel, "utf8"), "unchanged synthetic sentinel");
  unlinkSync(state); writeFileSync(state, saved, { mode: 0o600 }); f.open().close();
});

for (const mutation of [
  "PRAGMA application_id=123", "PRAGMA user_version=2", "CREATE TABLE alien_table (id TEXT)",
  "CREATE TABLE sqliteextra (id TEXT)", "DROP TABLE attention"
]) test(`journal rejects alien schema before changing it: ${mutation}`, t => {
  const f = fixture(t); f.open().close();
  inspect(f.directory, db => db.exec(mutation));
  const file = join(f.directory, "watch.sqlite"), before = readFileSync(file);
  assert.throws(() => f.open(), { code: "state_schema_mismatch" });
  assert.deepEqual(readFileSync(file), before);
});

test("malformed persisted checkpoint cannot be adopted as an unbound first use", t => {
  const f = fixture(t), journal = f.open();
  journal.reconcile(binding, checkpoint(), notices("a"), at); journal.close();
  inspect(f.directory, db => db.prepare("UPDATE checkpoint SET body=? WHERE id=1").run("null"));
  assert.throws(() => f.open(), { code: "state_schema_mismatch" });
});

for (const mutation of [
  "UPDATE attention SET notice='null'", "UPDATE attention SET signature='[]'",
  "UPDATE attention SET notice=json_set(notice,'$.memberId','another-member')",
  "UPDATE attention SET notice=json_set(notice,'$.notifyOnly',0)",
  "UPDATE control SET health='invented-state'", "DELETE FROM checkpoint"
]) test(`malformed stored notification/control data fails closed: ${mutation}`, t => {
  const f = fixture(t), journal = f.open();
  journal.reconcile(binding, checkpoint(), notices("a"), at); journal.close();
  inspect(f.directory, db => db.exec(mutation));
  assert.throws(() => f.open(), { code: "state_schema_mismatch" });
});

test("an existing database larger than the page budget cannot silently ignore that budget", t => {
  const f = fixture(t); f.open().close();
  inspect(f.directory, db => {
    const pageSize = db.prepare("PRAGMA page_size").get().page_size;
    assert.equal(pageSize, 4096, "this disposable fixture deliberately allocates about 17 MiB");
    db.prepare("INSERT INTO checkpoint VALUES(1,zeroblob(?))").run(pageSize * 4100);
    assert.ok(db.prepare("PRAGMA page_count").get().page_count > 4096);
  });
  assert.throws(() => f.open(), { code: "attention_capacity" });
});

test("a second process cannot acquire a live or paused owner and can recover after the owner is killed", { timeout: 15000, skip: process.platform === "win32" }, async t => {
  const f = fixture(t), { child, exited } = await holder(f);
  assert.deepEqual(probe(f.directory), { acquired: false, code: "already_watching" });
  child.kill("SIGSTOP");
  assert.deepEqual(probe(f.directory), { acquired: false, code: "already_watching" }, "pause must not expire ownership");
  const observer = f.open({ acquire: false }); assert.equal(observer.status().state, "held");
  assert.equal(observer.requestStop().state, "stop_requested", "stop can commit while the holder is paused");
  child.kill("SIGKILL"); await exited;
  assert.equal(observer.status().state, "stopped");
  assert.deepEqual(probe(f.directory), { acquired: true }, "OS-owned lock recovers without deleting files or a PID lease");
});

test("simultaneous starter processes grant lifetime ownership to exactly one contender", { timeout: 15000 }, async t => {
  const f = fixture(t); f.open().close();
  const candidates = await Promise.all([contender(f), contender(f)]);
  const results = await Promise.all(candidates.map(candidate => candidate.start()));
  assert.equal(results.filter(result => result.acquired).length, 1);
  assert.deepEqual(results.find(result => !result.acquired), { acquired: false, code: "already_watching" });
  assert.deepEqual(probe(f.directory), { acquired: false, code: "already_watching" });
});
