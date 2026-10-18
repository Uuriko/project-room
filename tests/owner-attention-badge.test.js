// #3340 — account-home Needs Attention badge + per-room deep-link lines.
// The badge/lines consume the landed GET /api/owner/overview document
// (slice 1, #3342/PR #3572) only: the badge count is the document's
// Decisions total verbatim, and the per-room lines group the Decisions
// items that document already carries. These tests pin that mapping
// against the same account fixture end to end (real overview over HTTP
// -> the client helpers/rendering that paint the account home), plus the
// zero-state: no badge, no lines.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createRoomServer } from "../server/http.mjs";
import {
  attentionBadgeCount, perRoomAttention, attentionLinesTruncated,
  roomAttentionHref, roomAttentionLinesHtml, createOwnerCockpit,
} from "../src/owner-cockpit.js";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-badge-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("room-a"));
  store.initialize(initialRoom("room-b"));
  store.db.exec(accessRequestSchema);
  const accessRequests = new AccessRequests(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  store.createAccount("owner-account");
  store.bindHumanAccount("room-a", "owner", "owner-account");
  store.bindHumanAccount("room-b", "owner", "owner-account");
  const key = store.issueAccountAccessKey("owner-account");
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, key, 0);
  const headers = { Cookie: `account_session=${slot.token}`, "X-Session-Binding": session.sessionBinding };
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ store, accessRequests, headers, origin: `http://127.0.0.1:${server.address().port}` });
  }));
}

function seedRequest(f, roomId, requestId) {
  const identity = f.store.identities.create("Joiner");
  return f.accessRequests.request(roomId, { identityId: identity.identityId, displayName: "Joiner",
    requestedPermissions: ["accept_work"], requestId }, identity.secret);
}

async function getOverview(f) {
  const response = await fetch(`${f.origin}/api/owner/overview`, { headers: f.headers });
  assert.equal(response.status, 200);
  return response.json();
}

test("badge count equals the overview Decisions total for the same account fixture", async t => {
  const f = await setup(t);
  seedRequest(f, "room-a", "ar-a1");
  seedRequest(f, "room-a", "ar-a2");
  seedRequest(f, "room-b", "ar-b1");
  const doc = await getOverview(f);
  assert.equal(doc.decisions.total, 3);
  assert.equal(attentionBadgeCount(doc), doc.decisions.total);
  assert.equal(attentionBadgeCount(doc), 3);
});

test("badge count is the Decisions total, not the capped items length", () => {
  const doc = { decisions: { total: 60, items: [{ roomId: "room-a", roomName: "A" }, { roomId: "room-a", roomName: "A" }] } };
  assert.equal(attentionBadgeCount(doc), 60);
  assert.equal(attentionLinesTruncated(doc), true);
  assert.match(roomAttentionLinesHtml(doc), /of 60 total/);
});

test("per-room lines deep-link to the right rooms with their counts", async t => {
  const f = await setup(t);
  seedRequest(f, "room-a", "ar-a1");
  seedRequest(f, "room-a", "ar-a2");
  seedRequest(f, "room-b", "ar-b1");
  const doc = await getOverview(f);
  const lines = perRoomAttention(doc);
  assert.deepEqual(Object.fromEntries(lines.map(line => [line.roomId, line.count])), { "room-a": 2, "room-b": 1 });
  // Every line's count comes from the document's own items for that room.
  for (const line of lines) {
    assert.equal(line.count, doc.decisions.items.filter(item => item.roomId === line.roomId).length);
    assert.equal(roomAttentionHref(line.roomId), `./?room=${line.roomId}`);
  }
  const html = roomAttentionLinesHtml(doc);
  assert.match(html, /href="\.\/\?room=room-a"/);
  assert.match(html, /href="\.\/\?room=room-b"/);
  assert.match(html, /2 need attention/);
  assert.match(html, /1 needs attention/);
  assert.equal(attentionLinesTruncated(doc), false);
});

test("per-room lines escape room names", () => {
  const doc = { decisions: { total: 1, items: [{ roomId: "room-x", roomName: "<script>alert(1)</script>" }] } };
  const html = roomAttentionLinesHtml(doc);
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("zero-state: an account with nothing waiting renders no badge and no lines", async t => {
  const f = await setup(t);
  const doc = await getOverview(f);
  assert.equal(doc.decisions.total, 0);
  assert.equal(attentionBadgeCount(doc), 0);
  assert.deepEqual(perRoomAttention(doc), []);
  assert.equal(roomAttentionLinesHtml(doc), "");
});

// --- Render wiring against a minimal fake section (no DOM, no network) ---

function fakeElement() {
  return { innerHTML: "", textContent: "", hidden: false, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; } };
}

function fakeSection() {
  const elements = {
    "#cockpit-summary": fakeElement(),
    "#cockpit-attention-badge": fakeElement(),
    "#cockpit-room-lines": fakeElement(),
    "#cockpit-decisions": fakeElement(),
    "#cockpit-exceptions": fakeElement(),
    "#cockpit-room-stubs": fakeElement(),
  };
  return { hidden: true, elements, querySelector(selector) { return elements[selector] ?? null; } };
}

test("cockpit render paints the badge and per-room lines from the overview document", async () => {
  const doc = {
    decisions: { total: 3, waiting: 3, overdue: 0, oldestAgeMs: 0, items: [
      { id: "i1", kind: "access_request", roomId: "room-a", roomName: "Alpha", title: "Join", ageMs: 0, consequence: null, actions: [] },
      { id: "i2", kind: "access_request", roomId: "room-a", roomName: "Alpha", title: "Join", ageMs: 0, consequence: null, actions: [] },
      { id: "i3", kind: "access_request", roomId: "room-b", roomName: "Beta", title: "Join", ageMs: 0, consequence: null, actions: [] },
    ] },
    exceptions: { total: 0, items: [] },
    rooms: { label: null },
    roomErrors: [],
  };
  const section = fakeSection();
  const cockpit = createOwnerCockpit({ accountClient: { ownerOverview: async () => doc }, section, decide: async () => {} });
  await cockpit.refresh();
  const badge = section.elements["#cockpit-attention-badge"];
  assert.equal(badge.textContent, "3");
  assert.equal(badge.hidden, false);
  const lines = section.elements["#cockpit-room-lines"].innerHTML;
  assert.match(lines, /href="\.\/\?room=room-a"/);
  assert.match(lines, /href="\.\/\?room=room-b"/);
  assert.match(lines, /Alpha/);
  assert.match(lines, /Beta/);
});

test("cockpit render at zero hides the badge and renders no per-room lines", async () => {
  const doc = { decisions: { total: 0, waiting: 0, overdue: 0, oldestAgeMs: 0, items: [] },
    exceptions: { total: 0, items: [] }, rooms: { label: null }, roomErrors: [] };
  const section = fakeSection();
  const cockpit = createOwnerCockpit({ accountClient: { ownerOverview: async () => doc }, section, decide: async () => {} });
  await cockpit.refresh();
  const badge = section.elements["#cockpit-attention-badge"];
  assert.equal(badge.textContent, "");
  assert.equal(badge.hidden, true);
  assert.equal(section.elements["#cockpit-room-lines"].innerHTML, "");
});
