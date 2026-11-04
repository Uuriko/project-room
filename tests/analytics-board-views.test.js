// #3588: board-view recording — the funnel's saw-board stage exists only
// if every board door leaves exactly one validated board_viewed fact with
// the claimable count the response carried, and recording can never break
// the read it rides on. Credible regressions: a door recording twice or
// not at all, a fact carrying content instead of counts, a recorder throw
// surfacing as a failed board read, an invalid count written as fact.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  BOARD_VIEWED_EVENT, boardDoorForRequest, readBoardViews, recordBoardView
} from "../server/analytics/board-views.mjs";
import { validateGrowthEvent } from "../server/analytics/catalog.mjs";
import { ensureAnalyticsSchema } from "../server/analytics/schema.mjs";
import { handlePublicWorkMcp } from "../server/mcp-public-work.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const NOW = Date.parse("2026-10-24T12:00:00.000Z");

function freshDb() {
  return new DatabaseSync(":memory:");
}

function rows(db) {
  return db.prepare("SELECT * FROM analytics_events WHERE name=?").all(BOARD_VIEWED_EVENT);
}

test("recordBoardView writes exactly one validated fact per call", () => {
  const db = freshDb();
  const first = recordBoardView(db, {
    actorId: "ai_1", door: "mcp", scope: "public", claimableCount: 7, at: NOW
  });
  assert.deepEqual(first, { written: true });
  const second = recordBoardView(db, {
    actorId: "m_h", actorKind: "human", door: "ui", roomId: "r1", scope: "room", claimableCount: 0, at: NOW + 1
  });
  assert.deepEqual(second, { written: true });
  const all = rows(db);
  assert.equal(all.length, 2);
  assert.notEqual(all[0].id, all[1].id);
  const pub = all.find(row => row.source === "mcp");
  assert.equal(pub.actor_id, "ai_1");
  assert.equal(pub.actor_kind, "agent");
  assert.equal(pub.room_id, null);
  assert.deepEqual(JSON.parse(pub.props), { claimable_count: 7, scope: "public" });
  const room = all.find(row => row.source === "ui");
  assert.equal(room.actor_kind, "human");
  assert.equal(room.room_id, "r1");
  assert.deepEqual(JSON.parse(room.props), { claimable_count: 0, scope: "room" });
  // The stored row shape passes the closed catalog validator.
  for (const row of all) {
    assert.equal(validateGrowthEvent({
      name: row.name, v: row.v, actor_kind: row.actor_kind, source: row.source,
      loop: row.loop, props: JSON.parse(row.props)
    }).ok, true);
  }
  db.close();
});

test("recordBoardView attributes no actor as anonymous and reads back in funnel shape", () => {
  const db = freshDb();
  recordBoardView(db, { door: "rest", scope: "public", claimableCount: 2, at: NOW });
  recordBoardView(db, { actorId: "ai_9", door: "mcp", scope: "public", claimableCount: 2, at: NOW - 5 });
  const [row] = rows(db).filter(r => r.source === "rest");
  assert.equal(row.actor_id, null);
  assert.equal(row.actor_kind, "anonymous");
  assert.deepEqual(readBoardViews(db), [
    { actorId: "ai_9", roomId: null, claimableCount: 2, at: NOW - 5 },
    { actorId: null, roomId: null, claimableCount: 2, at: NOW }
  ]);
  db.close();
});

test("recordBoardView refuses invalid facts and never throws", () => {
  const db = freshDb();
  const bad = [
    { door: "carrier-pigeon", scope: "public", claimableCount: 1 },
    { door: "ui", scope: "everywhere", claimableCount: 1 },
    { door: "ui", scope: "room", claimableCount: 1 },
    { door: "ui", scope: "public", claimableCount: -1 },
    { door: "ui", scope: "public", claimableCount: 1.5 },
    { door: "ui", scope: "public", claimableCount: "3" }
  ];
  for (const input of bad) {
    const result = recordBoardView(db, { ...input, at: NOW });
    assert.equal(result.written, false, JSON.stringify(input));
  }
  ensureAnalyticsSchema(db);
  assert.equal(rows(db).length, 0);
  assert.equal(recordBoardView(null, { door: "ui", scope: "public", claimableCount: 1 }).written, false);
  const broken = { prepare() { throw new Error("db gone"); } };
  assert.equal(recordBoardView(broken, { door: "ui", scope: "public", claimableCount: 1 }).written, false);
  assert.deepEqual(readBoardViews(freshDb()), []);
  db.close();
});

test("boardDoorForRequest separates cookie, bearer and mcp doors", () => {
  assert.equal(boardDoorForRequest({ url: "/api/public-work/tasks", headers: { cookie: "room_session=x" } }), "ui");
  assert.equal(boardDoorForRequest({ url: "/api/public-work/tasks", headers: { authorization: "Bearer abc" } }), "rest");
  assert.equal(boardDoorForRequest({ url: "/api/public-work/tasks", headers: {} }), "ui");
  assert.equal(boardDoorForRequest({ url: "/mcp", headers: {} }), "mcp");
});

test("the HTTP doors leave exactly one fact each: public list anonymous, in-room list as the member", async (t) => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  store.projectOffers.create("commons", "owner", { requestId: "create", offerId: "bv:task", reviewerMemberIds: ["owner"], terms: { kind: "task", title: "Board view task", summary: "Synthetic", acceptanceCriteria: ["Return exact bytes"], repositoryUrl: "https://github.com/example/project", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
  store.projectOffers.transition("commons", "owner", "bv:task", "publish", { requestId: "publish", expectedRevision: 1 });
  store.publicWorkClaims.enable("commons", "owner", "bv:task", { requestId: "enable", expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["result.js"] });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const created = await fetch(`${origin}/api/rooms/commons/work-claims`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "bv-claim", title: "Board view claim" })
  });
  assert.equal(created.status, 201, await created.clone().text().catch(() => ""));

  const listResponse = await fetch(`${origin}/api/rooms/commons/work-claims`, {
    headers: { authorization: `Bearer ${ownerKey}` }
  });
  assert.equal(listResponse.status, 200);
  await listResponse.json();

  const boardResponse = await fetch(`${origin}/api/public-work/tasks`);
  assert.equal(boardResponse.status, 200);
  const board = await boardResponse.json();
  assert.equal(board.claimableCount, 1);

  const all = rows(store.db);
  assert.equal(all.length, 2, JSON.stringify(all));
  const roomView = all.find(row => row.props.includes('"room"'));
  assert.equal(roomView.room_id, "commons");
  assert.equal(roomView.actor_id, "owner");
  assert.equal(roomView.actor_kind, "human");
  assert.equal(roomView.source, "rest");
  assert.deepEqual(JSON.parse(roomView.props), { claimable_count: 1, scope: "room" });
  const publicView = all.find(row => row.props.includes('"public"'));
  assert.equal(publicView.room_id, null);
  assert.equal(publicView.actor_id, null);
  assert.equal(publicView.actor_kind, "anonymous");
  assert.deepEqual(JSON.parse(publicView.props), { claimable_count: board.claimableCount, scope: "public" });

  // A HEAD on the public list serves no board and records no fact.
  const head = await fetch(`${origin}/api/public-work/tasks`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(rows(store.db).length, 2);
});

test("the MCP recommend door leaves exactly one board_viewed fact with the response's claimable count", () => {
  const db = freshDb();
  const store = {
    db,
    now: () => NOW,
    identities: { resolveGlobalIdentitySecret: () => ({ identityId: "ai_door" }) },
    publicWorkClaims: {
      match: () => ({ recommendations: [], claim: null, inspected: 0, hasMore: false, nextCursor: null }),
      list: () => ({ tasks: [], claimableCount: 4, nextCursor: null })
    }
  };
  const reply = handlePublicWorkMcp(store, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "public_work_recommend", arguments: {} }
  }, "secret");
  assert.ok(!reply.result.isError, JSON.stringify(reply));
  const all = rows(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].source, "mcp");
  assert.equal(all[0].actor_id, "ai_door");
  assert.deepEqual(JSON.parse(all[0].props), { claimable_count: 4, scope: "public" });
  db.close();
});

test("an-funnel-2 reports a non-null sawBoardAt and measured coverage for a recorded view", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "an-funnel-2-board-views-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "room.sqlite");
  const store = new RoomStore(dbPath);
  store.initialize(initialRoom());
  const rawEntry = store.db.prepare("SELECT MIN(json_extract(body,'$.at')) AS at FROM events WHERE json_extract(body,'$.type') IN ('member.added','member.joined_via_invitation')").get().at;
  const enteredAt = Number.isFinite(rawEntry) ? rawEntry : Date.parse(rawEntry);
  assert.ok(Number.isFinite(enteredAt), `member entry time: ${rawEntry}`);
  recordBoardView(store.db, {
    actorId: "owner", actorKind: "human", door: "ui", roomId: "commons",
    scope: "room", claimableCount: 3, at: enteredAt + 60000
  });
  store.close();
  const { stdout } = await execFileAsync(process.execPath, ["scripts/an-funnel-2.mjs", "--db", dbPath], {
    cwd: new URL("..", import.meta.url).pathname
  });
  const report = JSON.parse(stdout);
  assert.match(report.coverage.sawBoard, /measured from board_viewed/);
  assert.equal(report.coverage.boardViews, 1);
  const owner = report.actors.find(actor => actor.actorId === "owner");
  assert.ok(owner, JSON.stringify(report.actors));
  assert.equal(owner.sawBoardAt, enteredAt + 60000);
  assert.equal(owner.sawBoardClaimableCount, 3);
  assert.equal(report.summary.sawBoard, 1);
});
