// Central operator audit for POST /api/operator/unpublish (BACKLOG-BURN-1 /
// C7, hunt-2026-10-18 adversary.md P7).
//
// The unpublish door recorded its takedowns only in its own public_unpublish
// table (by_account), so an operator action was invisible in the central
// append-only operator_actions audit that purge and archive write to.
// Contracts owned here:
// - a successful unpublish appends one operator_actions row
//   (action "unpublish", the target kind/id, result "ok", the acting
//   account in counts);
// - a refusal AFTER authentication (non-operator account, unconfigured
//   operator, invalid target) also appends one row (result "refused",
//   counts.detail naming the refusal) — the audit shows attempts, not
//   just outcomes;
// - an unauthenticated attempt appends nothing (no actor to record).
// The takedown behaviour itself is covered by tests/legal-pages.test.js
// and is never re-asserted here.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { listOperatorActions } from "../server/operator-actions.mjs";

const OPERATOR_EMAIL = "legal-operator@example.invalid";
const OPERATOR_PASSWORD = "operator password one";
const OTHER_EMAIL = "legal-other@example.invalid";
const OTHER_PASSWORD = "other password one";

const operatorAccountId = `email:${createHash("sha256").update(OPERATOR_EMAIL).digest("hex")}`;
const otherAccountId = `email:${createHash("sha256").update(OTHER_EMAIL).digest("hex")}`;

async function serve(t, { operator = operatorAccountId } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-legal-audit-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store, operatorAccountId: operator });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, store };
}

async function raw(origin, path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...headers }, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

const cookieOf = res => /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") || "")?.[1] ?? null;

async function signup(origin, store, email, password) {
  const slot = store.createAccountSessionSlot();
  const res = await raw(origin, "/api/auth/password/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }),
  });
  const cookie = cookieOf(res);
  const session = cookie ? store.authenticateAccountSession(cookie) : null;
  return { status: res.status, cookie, account: session?.account ?? null, csrf: session?.csrf ?? null };
}

const unpublish = (origin, who, body) => raw(origin, "/api/operator/unpublish", {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: `account_session=${who.cookie}`, "X-CSRF-Token": who.csrf },
  body: JSON.stringify(body),
});

const auditRows = store => listOperatorActions(store, 50).filter(row => row.action === "unpublish");

test("a successful unpublish appends one central operator_actions row", async t => {
  const { origin, store } = await serve(t);
  const operator = await signup(origin, store, OPERATOR_EMAIL, OPERATOR_PASSWORD);
  assert.equal(operator.account.id, operatorAccountId);
  const res = await unpublish(origin, operator, { kind: "room", id: "commons" });
  assert.equal(res.status, 200);
  const rows = auditRows(store);
  assert.equal(rows.length, 1, "exactly one audit row for the takedown");
  assert.equal(rows[0].targetKind, "room");
  assert.equal(rows[0].targetId, "commons");
  assert.equal(rows[0].result, "ok");
  assert.equal(rows[0].counts.byAccount, operatorAccountId);
});

test("a non-operator refusal-with-auth appends a refused row and takes nothing down", async t => {
  const { origin, store } = await serve(t);
  const stranger = await signup(origin, store, OTHER_EMAIL, OTHER_PASSWORD);
  assert.equal(stranger.account.id, otherAccountId);
  const res = await unpublish(origin, stranger, { kind: "room", id: "commons" });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.text).error.code, "forbidden");
  const rows = auditRows(store);
  assert.equal(rows.length, 1, "the refused attempt is audited");
  assert.equal(rows[0].result, "refused");
  assert.equal(rows[0].counts.detail, "forbidden");
  assert.equal(rows[0].counts.byAccount, otherAccountId);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM public_unpublish").get().n, 0,
    "the refused attempt unpublished nothing");
});

test("an unconfigured-operator refusal-with-auth appends a refused row", async t => {
  const { origin, store } = await serve(t, { operator: "" });
  const created = await signup(origin, store, OPERATOR_EMAIL, OPERATOR_PASSWORD);
  const res = await unpublish(origin, created, { kind: "room", id: "commons" });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.text).error.code, "operator_unconfigured");
  const rows = auditRows(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, "refused");
  assert.equal(rows[0].counts.detail, "operator_unconfigured");
  assert.equal(rows[0].counts.byAccount, operatorAccountId);
});

test("an operator's invalid target appends a refused row naming the target", async t => {
  const { origin, store } = await serve(t);
  const operator = await signup(origin, store, OPERATOR_EMAIL, OPERATOR_PASSWORD);
  const res = await unpublish(origin, operator, { kind: "banana", id: "commons" });
  assert.equal(res.status, 422);
  assert.equal(JSON.parse(res.text).error.code, "invalid_unpublish");
  const rows = auditRows(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, "refused");
  assert.equal(rows[0].counts.detail, "invalid_unpublish");
  assert.equal(rows[0].targetKind, "banana");
  assert.equal(rows[0].targetId, "commons");
});

test("an unauthenticated attempt appends no audit row", async t => {
  const { origin, store } = await serve(t);
  const res = await raw(origin, "/api/operator/unpublish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "room", id: "commons" }),
  });
  assert.equal(res.status, 401);
  assert.equal(auditRows(store).length, 0, "no actor, no row");
});
