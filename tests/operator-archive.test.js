// Operator archive door: POST /api/operator/archive over a real store and
// HTTP server (server/operator-archive.mjs, server/operator-routes.mjs), the
// targeted parity certification it relies on (server/messages-store.mjs),
// and the projection-cap refusal copy, which used to tell people to ask the
// owner to "raise the room's limit" — a control that does not exist.
import { describe, test, before as beforeSuite, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const TOKEN = "operator-archive-token-0123456789abcdef";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const KEEP = 100;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-op-archive-"));
  // The room's flood guard refills on the store clock; step it per post.
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock, bodiesAtRest: true });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const post = (n, prefix = "m") => {
    for (let i = 0; i < n; i++) {
      clock += 10_000;
      store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `${prefix}-${i}`, body: `archive fixture ${prefix} ${i} `.padEnd(120, "x") } });
    }
  };
  const call = async (data, { token = TOKEN, path = "/api/operator/archive" } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Operator ${token}` } : {}) },
      body: JSON.stringify(data)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, body: json };
  };
  const bytes = () => store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS n FROM rooms WHERE id='commons'").get().n;
  const actions = () => store.db.prepare("SELECT action, result, counts_json FROM operator_actions ORDER BY at, rowid").all();
  return { store, owner, post, call, bytes, actions };
}

const REQUEST = { roomId: "commons", keepNewest: KEEP, reason: "projection cap relief" };

describe("operator archive door", { concurrency: false }, () => {
  beforeSuite(() => { process.env.ROOM_OPERATOR_TOKEN_SHA256 = HASH; });
  after(() => { delete process.env.ROOM_OPERATOR_TOKEN_SHA256; });

  test("a dry run catches the room up, certifies it, plans, and changes no room data", async t => {
    const f = await serve(t);
    f.post(KEEP + 30);
    const before = f.bytes();
    const plan = await f.call(REQUEST);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.equal(plan.body.dryRun, true);
    assert.ok(plan.body.archived >= 30, `archived ${plan.body.archived}`);
    assert.ok(plan.body.freedBytes > 0);
    assert.deepEqual(plan.body.expect, { archived: plan.body.archived, throughSeq: plan.body.throughSeq });
    assert.equal(f.bytes(), before, "a dry run leaves the projection alone");
    assert.equal(f.store.room("commons").state.messagesArchive, undefined);
    const audit = f.actions().at(-1);
    assert.equal(audit.action, "messages_archive_plan");
    assert.equal(audit.result, "ok");
    assert.equal(JSON.parse(audit.counts_json).archived, plan.body.archived);
  });

  test("a real run needs the dry run's counts; stale counts are refused with nothing changed", async t => {
    const f = await serve(t);
    f.post(KEEP + 30);
    const missing = await f.call({ ...REQUEST, dryRun: false });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error.code, "dry_run_required");
    const plan = await f.call(REQUEST);
    f.post(5, "late");
    const before = f.bytes();
    const stale = await f.call({ ...REQUEST, dryRun: false, expect: plan.body.expect });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error.code, "plan_changed");
    assert.equal(f.bytes(), before);
    assert.equal(f.store.room("commons").state.messagesArchive, undefined);
    assert.equal(f.actions().at(-1).result, "plan_changed");
  });

  test("a real run archives a room whose certification a later post voided, frees bytes, and posting continues", async t => {
    const f = await serve(t);
    f.post(KEEP + 40);
    // Certify the way the integrity job does, then let one more post land:
    // the bare archiveMessages call now refuses, the door does not.
    for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
    assert.equal(f.store.checkMessagesParity().ok, true);
    f.post(1, "after-certify");
    assert.equal(f.store.archiveMessages("commons", { keepNewest: KEEP }).reason, "messages_table_not_certified");
    const plan = await f.call(REQUEST);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    const before = f.bytes();
    const done = await f.call({ ...REQUEST, dryRun: false, expect: plan.body.expect });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.archived, plan.body.archived);
    assert.ok(f.bytes() < before, `projection ${before} -> ${f.bytes()}`);
    assert.equal(done.body.projectionBytes.before, before);
    assert.equal(done.body.projectionBytes.after, f.bytes());
    const state = f.store.room("commons").state;
    assert.equal(state.messagesArchive.count, plan.body.archived);
    assert.equal(f.store.checkMessagesParity({ roomId: "commons" }).ok, true);
    f.post(1, "after-archive");
    assert.ok(f.store.room("commons").state.messages.some(m => m.id === "after-archive-0"));
    const audit = f.actions().at(-1);
    assert.equal(audit.action, "messages_archive");
    assert.equal(audit.result, "ok");
  });

  test("a room that cannot certify is refused with the step named, audited, and left unchanged", async t => {
    const f = await serve(t);
    f.post(KEEP + 10);
    for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
    // The legacy shape research r57 found on prod: a stored message record
    // still carrying `reactions` that today's reducer no longer builds.
    const row = f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get();
    const projection = JSON.parse(row.projection);
    projection.messages[0].reactions = { "+1": ["owner"] };
    f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(projection));
    f.store._projectionCache?.clear?.();
    const before = f.bytes();
    const refused = await f.call(REQUEST);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "archive_not_ready");
    assert.match(refused.body.error.message, /parity_failed/);
    assert.equal(f.bytes(), before);
    const audit = f.actions().at(-1);
    assert.equal(audit.result, "refused");
    assert.equal(JSON.parse(audit.counts_json).detail, "parity_failed");
  });

  test("input is checked before anything runs", async t => {
    const f = await serve(t);
    const cases = [
      [{ ...REQUEST, extra: 1 }, 422, "invalid_archive_request"],
      [{ ...REQUEST, keepNewest: KEEP - 1 }, 422, "invalid_keep_newest"],
      [{ ...REQUEST, keepNewest: 150.5 }, 422, "invalid_keep_newest"],
      [{ ...REQUEST, dryRun: "no" }, 422, "invalid_archive_request"],
      [{ roomId: "commons" }, 422, "reason_required"],
      [{ ...REQUEST, expect: { archived: 1, throughSeq: 1 } }, 422, "invalid_archive_request"],
      [{ ...REQUEST, roomId: "../x" }, 422, "invalid_room_id"],
      [{ ...REQUEST, roomId: "no-such-room" }, 404, "room_not_found"]
    ];
    for (const [data, status, code] of cases) {
      const answer = await f.call(data);
      assert.equal(answer.status, status, `${JSON.stringify(data)} -> ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body.error.code, code);
    }
    assert.equal(f.actions().length, 0, "refused input writes no audit row");
  });

  test("without the operator token the door is the same 404 as an unknown path", async t => {
    const f = await serve(t);
    const unknown = await f.call(REQUEST, { path: "/api/operator/no-such-door" });
    const wrong = await f.call(REQUEST, { token: "wrong-token-0123456789abcdef0123" });
    assert.equal(unknown.status, 404);
    assert.equal(wrong.status, 404);
  });
});

test("targeted parity: a room not replayed to its head is not certified and the sweep does not move", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-parity-target-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "one", body: "one" } });
  assert.equal(store.checkMessagesParity({ roomId: "commons" }).reason, "not_caught_up");
  for (let i = 0; i < 20; i++) if (store.backfillMessages({ limit: 1000 }).done) break;
  const sweep = () => store.db.prepare("SELECT sweep_after FROM messages_backfill_cursor WHERE room_id NOT IN (SELECT id FROM rooms)").all();
  const before = sweep();
  const certified = store.checkMessagesParity({ roomId: "commons" });
  assert.equal(certified.ok, true);
  assert.equal(certified.roomId, "commons");
  assert.deepEqual(sweep(), before, "a targeted check leaves the sweep position alone");
  assert.throws(() => store.checkMessagesParity({ roomId: 7 }), TypeError);
});

test("no projection-cap refusal tells people to raise a limit that has no setting", () => {
  const dir = new URL("../server/", import.meta.url);
  const offenders = [];
  for (const name of readdirSync(dir).filter(file => file.endsWith(".mjs"))) {
    const source = readFileSync(new URL(name, dir), "utf8");
    const pattern = /fail\(\s*409\s*,\s*["']pilot_limit["']\s*,\s*("(?:\\.|[^"\\])*")/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (/raise the (?:room's )?limit/i.test(match[1])) offenders.push(`${name}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
  assert.deepEqual(offenders, []);
});
