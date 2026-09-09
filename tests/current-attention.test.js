import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { currentAttention } from "../client/attention-inbox.mjs";
import { contextNotices, AssignmentWatcher } from "../client/assignment-watcher.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-current-attention-")), state = join(directory, "pull");
  const store = new RoomStore(":memory:"); store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const id of ["agent", "other"]) {
    send("owner", T.MEMBER_ADDED, { memberId: id, displayName: id, kind: "agent", accountableHumanId: "owner", permissions: ["accept_work", "complete_work"] });
    keys[id] = store.issueAccessKey("commons", id);
  }
  const client = { snapshot: async () => store.snapshot(keys.agent, "commons"), changes: async (after, limit) => store.eventsAfter(keys.agent, "commons", after, limit) };
  const config = { client, origin: "http://127.0.0.1:12345", roomId: "commons", directory: state };
  const f = { directory, state, store, keys, client, send, config,
    pull: options => currentAttention({ ...config, ...options }),
    ack: (noticeId, options) => currentAttention({ ...config, noticeId, ...options }),
    work: (workItemId = "work", extra = {}) => send("owner", T.WORK_PROPOSED, { workItemId, title: "Synthetic task", definitionOfDone: "Return a useful draft", accountableMemberId: "agent", mode: "read", ...extra }),
    charter: (purpose = "Synthetic instructions") => send("owner", T.ROOM_CHARTER_UPDATED, { expectedRevision: store.room("commons").state.room.charter?.revision ?? 0, purpose, outputs: null, boundaries: null, escalation: null }),
    mutate: (type, workItemId = "work") => send("agent", type, { workItemId, expectedRevision: store.room("commons").state.workItems[workItemId].revision }) };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return f;
}
const inspect = (state, fn) => { const db = new DatabaseSync(join(state, "watch.sqlite")); try { return fn(db); } finally { db.close(); } };
const rows = state => inspect(state, db => ({ checkpoint: db.prepare("SELECT * FROM checkpoint").all(), attention: db.prepare("SELECT * FROM attention ORDER BY work_id").all() }));

test("pull persists exact pending notices until explicit acknowledgement and never mutates Room", async t => {
  const f = fixture(t); f.work(); f.charter();
  const before = f.store.snapshot(f.keys.agent, "commons");
  const first = await f.pull(); assert.equal(first.pending, 2); assert.equal(first.hasMore, false);
  assert.deepEqual(first.items.map(n => n.subject), ["instructions", "work"]);
  assert.ok(first.items.every(n => n.reason === "initial" && n.schemaVersion === 2));
  assert.deepEqual((await f.pull()).items, first.items, "read/reopen is not acknowledgement");
  for (const notice of first.items) {
    assert.equal((await f.ack(notice.id)).status, "acknowledged");
    assert.equal((await f.ack(notice.id)).status, "already_acknowledged");
  }
  assert.equal((await f.pull()).pending, 0);
  f.send("owner", T.MESSAGE_POSTED, { messageId: "unrelated", body: "This prose is not a request." });
  assert.equal((await f.pull()).pending, 0);
  const after = f.store.snapshot(f.keys.agent, "commons");
  assert.deepEqual(after.state.workItems, before.state.workItems); assert.equal(after.cursor, before.cursor);
  for (const key of Object.values(f.keys)) assert.equal(JSON.stringify([first, rows(f.state)]).includes(key), false);
  assert.equal(readFileSync(join(f.state, "watch.sqlite")).includes(Buffer.from("Synthetic instructions")), false);
});

test("instruction changes and clear notify during working without manufacturing work transitions", async t => {
  const f = fixture(t); f.work(); f.charter();
  f.mutate(T.WORK_ACCEPTED); f.mutate(T.WORK_STARTED);
  const initial = await f.pull(); assert.equal(initial.items.length, 1); assert.equal(initial.items[0].subject, "instructions");
  await f.ack(initial.items[0].id);
  const revision = f.store.room("commons").state.workItems.work.revision;
  const update = f.charter("Read the changed requirements before continuing");
  const changed = await f.pull(); assert.equal(changed.items[0].charter.eventId, update.event.id); assert.equal(changed.items[0].charter.revision, 2);
  assert.equal(changed.items[0].reason, "changed"); assert.equal(changed.items[0].next, undefined);
  assert.equal(f.store.room("commons").state.workItems.work.revision, revision);
  f.charter(null);
  assert.equal((await f.ack(changed.items[0].id)).status, "no_longer_current");
  const cleared = await f.pull(); assert.equal(cleared.items[0].charter.revision, 3);
  assert.notEqual(cleared.items[0].id, changed.items[0].id);
  assert.deepEqual(cleared.items[0].nextRead, { tool: "room_list_work", arguments: {} });
  assert.equal((await f.pull()).items[0].id, cleared.items[0].id);
});

test("obsolete work acknowledgement cannot clear a newer condition and irrelevant work stays quiet", async t => {
  const f = fixture(t); f.work(); f.work("unrelated", { accountableMemberId: "other" });
  const old = (await f.pull()).items[0]; assert.equal(old.next.action, "accept");
  f.mutate(T.WORK_ACCEPTED);
  assert.equal((await f.ack(old.id)).status, "no_longer_current");
  const fresh = (await f.pull()).items[0]; assert.equal(fresh.next.action, "start"); assert.notEqual(fresh.id, old.id);
  f.mutate(T.WORK_STARTED);
  assert.equal((await f.ack(fresh.id)).status, "no_longer_current"); assert.equal((await f.pull()).items.length, 0);
});

test("second reconciliation suppresses a pending work condition resolved during the read", async t => {
  const f = fixture(t); f.work(); let reads = 0;
  const client = { ...f.client, snapshot: async () => {
    if (++reads === 2) { f.mutate(T.WORK_ACCEPTED); f.mutate(T.WORK_STARTED); }
    return f.client.snapshot();
  } };
  assert.equal((await f.pull({ client })).pending, 0); assert.equal(reads, 2);
});

test("malformed or unavailable charter context refuses without advancing retained notices", async t => {
  const f = fixture(t); f.work(); f.charter(); await f.pull(); const before = rows(f.state);
  for (const damage of [s => delete s.charter, s => s.charter.revision++, s => delete s.state.room.charter,
    s => s.charter.authority = "permission", s => s.sequence = 1]) {
    const snapshot = await f.client.snapshot(); damage(snapshot);
    await assert.rejects(f.pull({ client: { ...f.client, snapshot: async () => snapshot } }));
    assert.deepEqual(rows(f.state), before);
  }
});

test("local history and identity changes refuse before disclosing or acknowledging pending state", async t => {
  const f = fixture(t); f.work(); const notice = (await f.pull()).items[0], before = rows(f.state);
  const wrong = { snapshot: async () => f.store.snapshot(f.keys.other, "commons"), changes: f.client.changes };
  await assert.rejects(f.ack(notice.id, { client: wrong }), { code: "identity_changed" });
  await assert.rejects(f.pull({ client: { ...f.client, changes: async (after, limit) => {
    const p = await f.client.changes(after, limit); p.events[0].event.id = "replaced-history"; return p;
  } } }), { code: "identity_changed" });
  f.store.revoke(f.keys.agent);
  await assert.rejects(f.ack(notice.id), { code: "unauthenticated" });
  assert.deepEqual(rows(f.state), before);
});

test("v2 requires its own directory and genuine old journal reader refuses it without changing pending state", async t => {
  const f = fixture(t); f.work(); await f.pull(); const before = rows(f.state);
  assert.throws(() => new WatchJournal(f.state), { code: "state_schema_mismatch" });
  const legacy = join(f.directory, "legacy"); const old = new WatchJournal(legacy);
  const watcher = new AssignmentWatcher({ ...f.config, journal: old, emit: async () => {} }); await watcher.reconcile(); old.close();
  const legacyBefore = rows(legacy);
  await assert.rejects(f.pull({ directory: legacy }), { code: "state_schema_mismatch" });
  assert.deepEqual(rows(legacy), legacyBefore);
  const historical = join(f.directory, "historical"); mkdirSync(join(historical, "client"), { recursive: true }); mkdirSync(join(historical, "src"));
  for (const path of ["client/watch-journal.mjs", "src/events.js", "src/room-charter.js", "src/workflow.js", "src/conversation.js", "src/work-packet.js"]) {
    writeFileSync(join(historical, path), execFileSync("git", ["show", "f91f4350dfb45955262df30740bcbc0d747fd5a1:" + path]));
  }
  writeFileSync(join(historical, "package.json"), '{"type":"module"}');
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `import { WatchJournal } from ${JSON.stringify(new URL("file://" + join(historical, "client/watch-journal.mjs")).href)}; try {new WatchJournal(process.argv[1]);process.exit(2);}catch(e){console.log(e.code);}`, f.state], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /state_schema_mismatch/); assert.deepEqual(rows(f.state), before);
});

test("v2 status is read-only; default stdout ack cannot silently acknowledge the pull inbox", async t => {
  const f = fixture(t); f.work(); const n = (await f.pull()).items[0];
  const observer = new WatchJournal(f.state, { acquire: false });
  assert.equal(observer.status().schemaVersion, 2); assert.equal(observer.status().pending, 1); observer.close();
  const holder = new WatchJournal(f.state, { version: 2 });
  assert.throws(() => holder.ack(n.id), { code: "explicit_ack_required" });
  await assert.rejects(f.pull(), { code: "already_watching" }); holder.close();
  assert.equal((await f.pull()).items[0].id, n.id);
});

test("bounded pull does not consume unseen rows; instruction and arbitrary work IDs have separate keys", async t => {
  const f = fixture(t); f.charter();
  for (let i = 0; i < 23; i++) f.work("work-" + i);
  f.work("instructions"); f.work("x".repeat(128));
  const page = await f.pull(); assert.equal(page.items.length, 20); assert.equal(page.pending, 26); assert.equal(page.hasMore, true);
  assert.deepEqual((await f.pull()).items, page.items);
  for (const n of page.items) await f.ack(n.id);
  const rest = await f.pull(); assert.equal(rest.pending, 6); assert.equal(rest.hasMore, false);
  assert.ok(rest.items.some(n => n.workItemId === "x".repeat(128)));
});

test("failed checkpoint and capacity changes roll back v2 notices and preserve the original ID", async t => {
  const f = fixture(t); f.work(); const first = (await f.pull()).items[0], before = rows(f.state);
  const holder = new WatchJournal(f.state, { version: 2 });
  const original = holder.state.bind(holder), old = original();
  // A rejected checkpoint identity is a bounded transaction failure after selection.
  assert.throws(() => holder.reconcile(old.binding, { sequence: old.sequence, eventId: "wrong-anchor" }, new Map(), Date.now()), { code: "history_changed" });
  const many = contextNotices(await f.client.snapshot());
  const entry = structuredClone([...many.values()][0]); entry.payload.title = "z".repeat(9000);
  many.set(JSON.stringify(["work", "work"]), { ...entry, signature: entry.signature + "changed" });
  assert.throws(() => holder.reconcile(old.binding, { sequence: old.sequence + 1, eventId: "next" }, many, Date.now()), { code: "attention_capacity" });
  f.charter("Another pending condition");
  inspect(f.state, db => db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT,'fixture commit refusal'); END"));
  try { assert.throws(() => holder.reconcile(old.binding, { sequence: old.sequence + 1, eventId: "next" }, contextNotices(f.store.snapshot(f.keys.agent, "commons")), Date.now()), /fixture commit refusal/); }
  finally { inspect(f.state, db => db.exec("DROP TRIGGER fail_checkpoint")); }
  holder.close(); assert.deepEqual(rows(f.state), before); assert.equal((await f.pull()).items.find(n => n.subject === "work").id, first.id);
});

test("duplicate persisted IDs or an invalid read pointer refuse without dismissing either subject", async t => {
  const f = fixture(t); f.work(); f.charter(); await f.pull();
  const before = rows(f.state), firstId = JSON.parse(before.attention[0].notice).id;
  inspect(f.state, db => db.prepare("UPDATE attention SET notice=json_set(notice,'$.id',?)").run(firstId));
  const damaged = rows(f.state);
  await assert.rejects(f.ack(firstId), { code: "state_schema_mismatch" }); assert.deepEqual(rows(f.state), damaged);
  inspect(f.state, db => { for (const row of before.attention) db.prepare("UPDATE attention SET notice=? WHERE work_id=?").run(row.notice, row.work_id); });
  const holder = new WatchJournal(f.state, { version: 2 });
  inspect(f.state, db => db.prepare("UPDATE attention SET notice=json_set(notice,'$.id',?)").run(firstId));
  assert.throws(() => holder.acknowledge(firstId), { code: "state_schema_mismatch" }); holder.close();
  inspect(f.state, db => { for (const row of before.attention) db.prepare("UPDATE attention SET notice=? WHERE work_id=?").run(row.notice, row.work_id);
    db.exec("UPDATE attention SET notice=json_set(notice,'$.nextRead.tool','room_accept_work')"); });
  await assert.rejects(f.pull(), { code: "state_schema_mismatch" });
});

test("failed first authentication creates no local state", async t => {
  const f = fixture(t); f.store.revoke(f.keys.agent);
  await assert.rejects(f.pull(), { code: "unauthenticated" }); assert.equal(existsSync(f.state), false);
});

test("explicit cancellation and another process's stop interrupt a held read without ack or checkpoint", async t => {
  const f = fixture(t); f.work(); const n = (await f.pull()).items[0], before = rows(f.state);
  for (const method of ["signal", "stop"]) {
    let entered; const ready = new Promise(resolve => entered = resolve), controller = new AbortController();
    const operation = f.ack(n.id, { signal: controller.signal, client: { ...f.client, snapshot: async ({ signal }) => {
      entered(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } } });
    await ready;
    if (method === "signal") controller.abort();
    else { const observer = new WatchJournal(f.state, { acquire: false }); assert.equal(observer.requestStop().state, "stop_requested"); observer.close(); }
    await assert.rejects(operation); assert.deepEqual(rows(f.state), before);
  }
  assert.equal((await f.pull()).items[0].id, n.id);
  await assert.rejects(f.ack("valid-but-missing", { directory: join(f.directory, "missing") }));
  assert.equal(existsSync(join(f.directory, "missing")), false);
});
