// P0-6: messages archival gets its callers — the owner-only operator route
// and the 70%-of-cap job. Exercises server/messages-archive.mjs,
// server/operator-archive.mjs (through server/operator-routes.mjs over real
// HTTP), the messages-archive job in server/jobs.mjs, and the dry-run
// report fields added to archiveRoomMessages in server/messages-store.mjs.
//
// Every store here is a local shaped fixture: a real RoomStore on an
// in-memory database (the ":memory:" pattern other suites in this repo
// use), seeded through the normal command path. In-memory is deliberate —
// it keeps the suite runnable where file-backed SQLite is unavailable.
// Nothing in this file touches a live or production room.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import {
  ARCHIVE_MIN_KEEP_NEWEST, archiveLiveOptedIn, archiveTargetBytes, archiveTriggerBytes,
  roomsOverArchiveTrigger, runMessagesArchiveTick, archiveDryRunReport
} from "../server/messages-archive.mjs";
import { JOBS, jobByName, jobEnabled } from "../server/jobs.mjs";

const TOKEN = "operator-archive-test-token-0123456789";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const CAP = 4 * 1024 * 1024;

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

// A certified room: messages posted through commands, the messages table
// backfilled, and parity certified at the head — the precondition
// archiveRoomMessages itself enforces.
function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "human", displayName: "human", kind: "human",
    permissions: ["accept_work", "complete_work", "verify"]
  }));
  const human = store.issueAccessKey("commons", "human");
  t.after(() => { store.close(); });
  const send = (body, id) => store.command(human, "commons", command(T.MESSAGE_POSTED, { messageId: id, body }, id));
  // Bulk seeding rotates across six members: the room flood guard allows
  // a burst of 30 posts per member, so one sender cannot seed 150.
  const senders = [];
  for (let s = 0; s < 6; s++) {
    store.command(owner, "commons", command(T.MEMBER_ADDED, {
      memberId: `sender-${s}`, displayName: `sender-${s}`, kind: "human",
      permissions: ["accept_work", "complete_work", "verify"]
    }));
    senders.push(store.issueAccessKey("commons", `sender-${s}`));
  }
  const bulk = (count, prefix, body) => {
    for (let i = 0; i < count; i++) {
      store.command(senders[i % senders.length], "commons",
        command(T.MESSAGE_POSTED, { messageId: `${prefix}-${i}`, body: body(i) }, `${prefix}-${i}`));
    }
  };
  const certify = () => {
    for (let i = 0; i < 20; i++) if (store.backfillMessages({ limit: 1000 }).done) break;
    assert.equal(store.checkMessagesParity().ok, true);
  };
  return { store, human, send, bulk, certify };
}

function projectionBytes(store, roomId = "commons") {
  return store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS bytes FROM rooms WHERE id=?").get(roomId).bytes;
}

// Grow the stored projection past a chosen size with inert room state the
// reducer would never produce at this scale in a unit test (a pad field).
// The messages and their table rows stay real and certified; only
// non-message bulk is synthetic, which is exactly the muse-room shape:
// the trigger is about total projection bytes, not message count.
function padProjection(store, targetBytes, roomId = "commons") {
  const row = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
  const projection = JSON.parse(row.projection);
  projection.archivePad = "";
  const base = Buffer.byteLength(JSON.stringify(projection));
  projection.archivePad = "x".repeat(Math.max(0, targetBytes - base));
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), roomId);
  return projectionBytes(store, roomId);
}

test("trigger math: 70% of the 4 MiB cap, first triggering byte is 2,936,013", () => {
  assert.equal(archiveTriggerBytes(), 2_936_013);
  assert.equal(archiveTriggerBytes(CAP), Math.floor(CAP * 0.7) + 1);
  assert.ok(2_936_012 < CAP * 0.7 && 2_936_013 > CAP * 0.7);
  assert.equal(archiveTargetBytes(), Math.floor(CAP * 0.5));
  assert.equal(archiveLiveOptedIn({}), false);
  assert.equal(archiveLiveOptedIn({ ROOM_MESSAGES_ARCHIVE_LIVE: "1" }), true);
  assert.equal(archiveLiveOptedIn({ ROOM_MESSAGES_ARCHIVE_LIVE: "true" }), false);
});

test("archiveRoomMessages dry-run report carries timestamps and projection sizes, and moves nothing", t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) f.send(`report body ${i}`, `r-${i}`);
  f.certify();
  const before = f.store.room("commons").state.messages.length;
  const plan = f.store.archiveMessages("commons", { keepNewest: 4 });
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.ok(plan.archived > 0 && plan.freedBytes > 0);
  const moving = f.store.room("commons").state.messages.slice(0, plan.archived);
  assert.equal(plan.oldestAt, moving[0].createdAt);
  assert.equal(plan.newestAt, moving[moving.length - 1].createdAt);
  assert.equal(plan.projectionBytesBefore, projectionBytes(f.store));
  assert.ok(plan.resultingProjectionBytes < plan.projectionBytesBefore);
  assert.ok(Math.abs(plan.projectionBytesBefore - plan.resultingProjectionBytes - plan.freedBytes) < 512,
    "resulting size tracks the freed bytes (plus the small archive marker)");
  assert.equal(f.store.room("commons").state.messages.length, before, "dry run changes nothing");
  const done = f.store.archiveMessages("commons", { keepNewest: 4, dryRun: false });
  assert.equal(done.archived, plan.archived);
  const afterBytes = projectionBytes(f.store);
  assert.ok(Math.abs(afterBytes - plan.resultingProjectionBytes) < 512,
    `live result ${afterBytes} matches the dry-run prediction ${plan.resultingProjectionBytes}`);
});

test("roomsOverArchiveTrigger lists only rooms at or over 70%, largest first", t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) f.send(`trigger body ${i}`, `t-${i}`);
  f.certify();
  assert.deepEqual(roomsOverArchiveTrigger(f.store), []);
  padProjection(f.store, archiveTriggerBytes() - 1);
  assert.deepEqual(roomsOverArchiveTrigger(f.store), [], "one byte under the trigger is not over it");
  padProjection(f.store, archiveTriggerBytes());
  const over = roomsOverArchiveTrigger(f.store);
  assert.equal(over.length, 1);
  assert.equal(over[0].roomId, "commons");
  assert.ok(over[0].projectionBytes >= archiveTriggerBytes());
});

test("archiveDryRunReport reports what would move for an over-trigger room", t => {
  const f = fixture(t);
  f.bulk(150, "b", i => `bulk ${i} ${"y".repeat(200)}`);
  f.certify();
  padProjection(f.store, archiveTriggerBytes() + 10_000);
  const report = archiveDryRunReport(f.store, "commons");
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.live, false);
  assert.equal(report.overTrigger, true);
  assert.equal(report.capBytes, CAP);
  assert.equal(report.triggerBytes, archiveTriggerBytes());
  assert.ok(report.keepNewest >= ARCHIVE_MIN_KEEP_NEWEST);
  assert.equal(report.wouldArchive, report.plan.archived);
  assert.ok(report.wouldArchive > 0);
  assert.ok(report.plan.freedBytes > 0);
  assert.equal(typeof report.plan.oldestAt, "string");
  assert.equal(typeof report.plan.newestAt, "string");
  assert.ok(report.plan.resultingProjectionBytes < report.plan.projectionBytesBefore,
    "the plan shrinks the projection by the freed message bytes; the synthetic pad is not messages, so no message plan can pull this fixture under the 50% target");
});

test("the job is registered like the other slow jobs and stays disabled under the trigger", t => {
  const job = jobByName("messages-archive");
  assert.ok(job, "job exists");
  assert.ok(JOBS.includes(job));
  assert.equal(job.slow, true);
  assert.deepEqual([...job.runtimes].sort(), ["node", "worker"]);
  const f = fixture(t);
  f.send("small room", "only");
  f.certify();
  assert.equal(jobEnabled(job, {}, f.store), false);
  assert.equal(typeof job.disabledReason({}, f.store), "string");
});

test("job tick in default posture is a dry run: it reports and moves nothing", async t => {
  const f = fixture(t);
  f.bulk(150, "j", i => `job body ${i} ${"z".repeat(120)}`);
  f.certify();
  padProjection(f.store, archiveTriggerBytes() + 5_000);
  const beforeCount = f.store.room("commons").state.messages.length;
  const beforeBytes = projectionBytes(f.store);
  const job = jobByName("messages-archive");
  assert.equal(jobEnabled(job, {}, f.store), true);
  const summary = await job.run(f.store, { env: {}, deadline: Date.now() + 5000 });
  assert.equal(summary.rooms, 1);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.archived, 0);
  assert.ok(summary.wouldArchive > 0);
  assert.equal(f.store.room("commons").state.messages.length, beforeCount);
  assert.equal(projectionBytes(f.store), beforeBytes);
});

test("job tick with the env opt-in archives for real and is idempotent", t => {
  const f = fixture(t);
  f.bulk(150, "l", i => `live body ${i} ${"z".repeat(120)}`);
  f.certify();
  const result = runMessagesArchiveTick(f.store, { env: { ROOM_MESSAGES_ARCHIVE_LIVE: "1" } });
  // The room is under the trigger (no pad): nothing is due, nothing moves.
  assert.equal(result.rooms, 0);
  padProjection(f.store, archiveTriggerBytes() + 5_000);
  const live = runMessagesArchiveTick(f.store, { env: { ROOM_MESSAGES_ARCHIVE_LIVE: "1" } });
  assert.equal(live.live, true);
  assert.equal(live.dryRun, false);
  assert.equal(live.rooms, 1);
  assert.ok(live.archived > 0, "the opt-in tick moved messages");
  assert.equal(f.store.room("commons").state.messagesArchive.count, live.archived);
  const again = runMessagesArchiveTick(f.store, { env: { ROOM_MESSAGES_ARCHIVE_LIVE: "1" } });
  assert.equal(again.archived, 0, "a second tick has nothing left to move");
});

describe("operator messages archive route", { concurrency: false }, () => {
  before(() => { process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH; });
  after(() => { delete process.env.ROOM_OPERATOR_TOKEN_SHA256; });

  async function serve(t) {
    const store = new RoomStore(":memory:");
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    store.command(owner, "commons", command(T.MEMBER_ADDED, {
      memberId: "human", displayName: "human", kind: "human",
      permissions: ["accept_work", "complete_work", "verify"]
    }));
    const human = store.issueAccessKey("commons", "human");
    const send = (body, id) => store.command(human, "commons", command(T.MESSAGE_POSTED, { messageId: id, body }, id));
    for (let i = 0; i < 10; i++) send(`route body ${i}`, `m-${i}`);
    for (let i = 0; i < 20; i++) if (store.backfillMessages({ limit: 1000 }).done) break;
    assert.equal(store.checkMessagesParity().ok, true);
    const server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      store.close();
    });
    const call = async ({ method = "POST", data, token = TOKEN, cookie, authorization } = {}) => {
      const auth = authorization !== undefined ? authorization : (token ? `Operator ${token}` : null);
      const response = await fetch(`${origin}/api/operator/messages/archive`, {
        method,
        headers: {
          Origin: origin,
          ...(auth ? { Authorization: auth } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(data !== undefined ? { "Content-Type": "application/json" } : {})
        },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {})
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: response.status, body: parsed };
    };
    return { store, call };
  }

  test("refusals: no token, wrong token, and a room cookie all answer the same 404", async t => {
    const { call } = await serve(t);
    const data = { roomId: "commons" };
    assert.equal((await call({ data, token: null })).status, 404);
    assert.equal((await call({ data, token: "wrong-token-wrong-token-wrong-012345" })).status, 404);
    assert.equal((await call({ data, token: null, cookie: "room_session=abc" })).status, 404);
    assert.equal((await call({ data, authorization: "Bearer something-else" })).status, 404);
    const get = await call({ method: "GET", data: undefined });
    assert.equal(get.status, 405);
  });

  test("dry run is the default: the route reports what would move and moves nothing", async t => {
    const { store, call } = await serve(t);
    const before = store.room("commons").state.messages.length;
    const res = await call({ data: { roomId: "commons", keepNewest: 4 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.live, false);
    assert.ok(res.body.wouldArchive > 0);
    assert.ok(res.body.plan.freedBytes > 0);
    assert.equal(typeof res.body.plan.oldestAt, "string");
    assert.equal(typeof res.body.plan.newestAt, "string");
    assert.ok(res.body.plan.resultingProjectionBytes < res.body.plan.projectionBytesBefore);
    assert.equal(store.room("commons").state.messages.length, before, "nothing moved");
    const actions = store.db.prepare("SELECT action, result FROM operator_actions ORDER BY at DESC").all();
    assert.ok(actions.some(row => row.action === "messages_archive" && row.result === "dry_run"), "the dry run is audited");
  });

  test("validation: bad room ids and bad fields are 422, an unknown room is 404", async t => {
    const { call } = await serve(t);
    assert.equal((await call({ data: {} })).status, 422);
    assert.equal((await call({ data: { roomId: "not a room!" } })).status, 422);
    assert.equal((await call({ data: { roomId: "commons", keepNewest: 0 } })).status, 422);
    assert.equal((await call({ data: { roomId: "commons", live: "yes" } })).status, 422);
    assert.equal((await call({ data: { roomId: "commons", surprise: 1 } })).status, 422);
    assert.equal((await call({ data: { roomId: "no-such-room" } })).status, 404);
  });

  test("live:true performs the archival, and only because it was explicit", async t => {
    const { store, call } = await serve(t);
    const before = store.room("commons").state.messages.length;
    const res = await call({ data: { roomId: "commons", keepNewest: 4, live: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.live, true);
    assert.equal(res.body.dryRun, false);
    assert.ok(res.body.archived > 0);
    assert.equal(store.room("commons").state.messages.length, before - res.body.archived);
    assert.equal(store.room("commons").state.messagesArchive.count, res.body.archived);
  });
});
