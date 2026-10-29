// #3616 (R-5/R-11): direct coverage for server/routes/decision-rows.mjs —
// the route-table rows and their handler validation. The end-to-end HTTP
// behaviour (owner gate, audit records, payload) is owned by
// tests/decision-rows.test.js; this file pins the route declarations and
// the handlers' own parameter validation with a stubbed ctx.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DECISION_ROWS_ROUTES, exportDecisionRows, readDecisionAccessLog,
} from "../server/routes/decision-rows.mjs";

class Reject extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// A ctx whose session auth resolves to the room owner ("owner"), with a
// store stub shaped like the real one's surface the handlers touch.
function ownerCtx(url, { prepareExport, listAccessLog } = {}) {
  const sent = [];
  const store = {
    room: () => ({ state: { room: { ownerId: "owner" } } }),
    command: () => ({}),
    decisionRows: {
      prepareExport: prepareExport ?? (() => ({ schema: "decision-rows/1", rowCount: 0, rows: [] })),
      recordExportAudit: payload => payload,
      listAccessLog: listAccessLog ?? (() => []),
    },
  };
  const ctx = {
    params: { roomId: "commons" },
    url: new URL(url),
    req: { method: "GET" },
    res: {},
    store,
    roomCredentials: () => ({ mode: "session", bearer: false, token: "tok" }),
    expectedBinding: () => null,
    accountBinding: () => null,
    roomAuth: () => ({ kind: "session", credentialHash: "hash", member: { id: "owner" } }),
    rate: () => {},
    reject: (status, code, message) => { throw new Reject(status, code, message); },
    json: (res, status, body, head) => { sent.push({ status, body, head }); return body; },
  };
  return { ctx, sent };
}

test("decision-rows routes: the route table declares owner export + access-log rows for GET and HEAD", () => {
  assert.equal(DECISION_ROWS_ROUTES.length, 4);
  assert.deepEqual(DECISION_ROWS_ROUTES.map(row => row.id).sort(), [
    "decision-rows-access-log-GET", "decision-rows-access-log-HEAD",
    "decision-rows-export-GET", "decision-rows-export-HEAD",
  ]);
  for (const row of DECISION_ROWS_ROUTES) {
    assert.equal(row.auth, "room");
    assert.equal(row.scope, "room");
    assert.equal(row.schema.params.required[0], "roomId");
  }
  const exported = DECISION_ROWS_ROUTES.filter(row => row.path === "/api/rooms/{roomId}/decision-rows");
  assert.deepEqual(exported.map(row => row.events), [["room.exported"], ["room.exported"]]);
  assert.equal(exported[0].handler, exportDecisionRows);
  const accessLog = DECISION_ROWS_ROUTES.filter(row => row.path === "/api/rooms/{roomId}/decision-rows/access-log");
  assert.equal(accessLog[0].handler, readDecisionAccessLog);
});

test("decision-rows export handler: any query parameter is refused invalid_decision_export", async () => {
  const { ctx } = ownerCtx("https://room.test/api/rooms/commons/decision-rows?format=json");
  await assert.rejects(exportDecisionRows(ctx),
    error => error instanceof Reject && error.status === 422 && error.code === "invalid_decision_export");
});

test("decision-rows export handler: a clean request returns the audited payload", async () => {
  const payload = { schema: "decision-rows/1", rowCount: 2, rows: [{ rowId: "a" }, { rowId: "b" }] };
  const { ctx, sent } = ownerCtx("https://room.test/api/rooms/commons/decision-rows",
    { prepareExport: () => payload });
  const body = await exportDecisionRows(ctx);
  assert.equal(body, payload);
  assert.deepEqual(sent, [{ status: 200, body: payload, head: false }]);
});

test("decision-rows access-log handler: bad limits and stray parameters are refused invalid_access_log", async () => {
  for (const query of ["limit=0", "limit=501", "limit=abc", "limit=5&limit=6", "cursor=next"]) {
    const { ctx } = ownerCtx(`https://room.test/api/rooms/commons/decision-rows/access-log?${query}`);
    await assert.rejects(readDecisionAccessLog(ctx),
      error => error instanceof Reject && error.status === 422 && error.code === "invalid_access_log",
      query);
  }
});

test("decision-rows access-log handler: the limit reaches the store, defaulting to 100", async () => {
  const seen = [];
  const listAccessLog = (roomId, options) => { seen.push([roomId, options]); return [{ id: 1 }]; };
  const bounded = ownerCtx("https://room.test/api/rooms/commons/decision-rows/access-log?limit=7", { listAccessLog });
  assert.deepEqual(await readDecisionAccessLog(bounded.ctx), { roomId: "commons", entries: [{ id: 1 }] });
  const plain = ownerCtx("https://room.test/api/rooms/commons/decision-rows/access-log", { listAccessLog });
  await readDecisionAccessLog(plain.ctx);
  assert.deepEqual(seen, [["commons", { limit: 7 }], ["commons", { limit: 100 }]]);
});

test("decision-rows handlers: a non-owner session is refused before any validation or read", async () => {
  const { ctx } = ownerCtx("https://room.test/api/rooms/commons/decision-rows/access-log?limit=0");
  ctx.roomAuth = () => ({ kind: "session", credentialHash: "hash", member: { id: "member" } });
  await assert.rejects(readDecisionAccessLog(ctx),
    error => error instanceof Reject && error.status === 403 && error.code === "owner_required");
});
