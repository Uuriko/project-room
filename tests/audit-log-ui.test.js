// F004: audit log UI renderer tests. Pure presentation tests: representative
// audit entries (actor, action, target, timestamp formatting), the empty log,
// and XSS-safety of every untrusted string the renderer emits.
import test from "node:test";
import assert from "node:assert/strict";
import {
  auditActionLabel,
  auditTarget,
  formatAuditTime,
  renderAuditRow,
  renderAuditLog
} from "../src/audit-log-ui.mjs";

const posted = (overrides = {}) => ({
  sequence: 7,
  event: {
    id: "e_posted",
    type: "message.posted",
    roomId: "room_1",
    actorId: "m_avery",
    at: "2026-09-16T00:04:21.000Z",
    data: { messageId: "m_42", body: "<script>alert(1)</script>" },
    ...overrides
  }
});

test("known event types get past-tense action labels", () => {
  assert.equal(auditActionLabel("message.posted"), "Posted a message");
  assert.equal(auditActionLabel("message.deleted"), "Deleted a message");
  assert.equal(auditActionLabel("work.completed"), "Completed work");
  assert.equal(auditActionLabel("work.handoff_recorded"), "Recorded a work handoff");
  assert.equal(auditActionLabel("member.added"), "Added a member");
  assert.equal(auditActionLabel("member.access_changed"), "Changed member access");
  assert.equal(auditActionLabel("room.archived"), "Archived the room");
  assert.equal(auditActionLabel("room.spend_allowance_set"), "Set the spend allowance");
  assert.equal(auditActionLabel("claim.acquired"), "Acquired a claim");
  assert.equal(auditActionLabel("verification.recorded"), "Recorded verification");
  assert.equal(auditActionLabel("owner.decision_recorded"), "Recorded an owner decision");
  assert.equal(auditActionLabel("session.started"), "Started a session");
  assert.equal(auditActionLabel("reply_request.cancelled"), "Cancelled a reply request");
  assert.equal(auditActionLabel("work.help_offer_opened"), "Opened a help offer");
  assert.equal(auditActionLabel("capabilities.advertised"), "Advertised capabilities");
});

test("unknown event types fall back to a humanized label instead of throwing", () => {
  assert.equal(auditActionLabel("custom.thing_happened"), "Custom thing happened");
  assert.equal(auditActionLabel(undefined), "Unknown event");
  assert.equal(auditActionLabel(null), "Unknown event");
});

test("targets pick the id that matches the action family", () => {
  assert.deepEqual(auditTarget(posted().event), { kind: "message", id: "m_42" });
  assert.deepEqual(
    auditTarget({ id: "e1", type: "work.completed", actorId: "m_a", data: { workItemId: "w_9" } }),
    { kind: "work item", id: "w_9" });
  assert.deepEqual(
    auditTarget({ id: "e2", type: "member.added", actorId: "m_owner", data: { memberId: "m_new" } }),
    { kind: "member", id: "m_new" });
  assert.deepEqual(
    auditTarget({ id: "e3", type: "room.archived", roomId: "room_1", actorId: "m_owner", data: {} }),
    { kind: "room", id: "room_1" });
  assert.deepEqual(
    auditTarget({ id: "e4", type: "session.stopped", actorId: "m_a", data: { workItemId: "w_9" } }),
    { kind: "session", id: "w_9" });
  assert.deepEqual(
    auditTarget({ id: "e5", type: "custom.unknown" }),
    { kind: "event", id: "e5" });
});

test("target extraction tolerates missing data without throwing", () => {
  assert.deepEqual(auditTarget(null), { kind: "event", id: undefined });
  assert.deepEqual(auditTarget({}), { kind: "event", id: undefined });
  assert.deepEqual(auditTarget({ id: "e6", type: "message.deleted" }), { kind: "message", id: "e6" });
});

test("timestamps render as UTC text; invalid ones pass through raw", () => {
  assert.equal(formatAuditTime("2026-09-16T00:04:21.000Z"), "2026-09-16 00:04:21 UTC");
  assert.equal(formatAuditTime("2026-09-16T00:04:21Z"), "2026-09-16 00:04:21 UTC");
  assert.equal(formatAuditTime("not-a-time"), "not-a-time");
  assert.equal(formatAuditTime(undefined), "");
});

test("a row shows who did what when, with a machine-readable <time>", () => {
  const html = renderAuditRow(posted(), { resolveName: { m_avery: "Avery Quinn" } });
  assert.match(html, /<td class="audit-actor">Avery Quinn<\/td>/);
  assert.match(html, /Posted a message/);
  assert.match(html, /<code>m_42<\/code>/);
  assert.match(html, /<time datetime="2026-09-16T00:04:21\.000Z">2026-09-16 00:04:21 UTC<\/time>/);
  assert.match(html, /<code>7<\/code>/);
});

test("name resolution accepts a function or a Map and falls back to the raw id", () => {
  const byFn = renderAuditRow(posted(), { resolveName: id => (id === "m_avery" ? "Avery" : null) });
  assert.match(byFn, /Avery/);
  const byMap = renderAuditRow(posted(), { resolveName: new Map([["m_avery", "A. Quinn"]]) });
  assert.match(byMap, /A\. Quinn/);
  const unknown = renderAuditRow(posted());
  assert.match(unknown, /<td class="audit-actor">m_avery<\/td>/);
});

test("untrusted text is escaped everywhere it can reach the document", () => {
  const evil = {
    sequence: 1,
    event: {
      id: "e\"onmouseover=\"x",
      type: "message.posted\"><script>alert(2)</script>",
      roomId: "r1",
      actorId: "<img src=x onerror=alert(1)>",
      at: "2026-09-16T00:04:21.000Z",
      data: { messageId: "\"><svg onload=alert(3)>" }
    }
  };
  const html = renderAuditRow(evil, { resolveName: { "<img src=x onerror=alert(1)>": "<b>Avery</b>" } });
  assert.ok(!html.includes("<img src=x"), "actor id must be escaped");
  assert.ok(!html.includes("<script>"), "event type must be escaped");
  assert.ok(!html.includes("<svg onload"), "target id must be escaped");
  assert.ok(!html.includes("<b>Avery</b>"), "resolved names must be escaped too");
  assert.ok(html.includes("&lt;b&gt;Avery&lt;/b&gt;"), "escaped name is present");
  // Without a name mapping the raw actor id renders escaped, never raw.
  const raw = renderAuditRow(evil);
  assert.ok(!raw.includes("<img src=x"), "raw actor id must be escaped");
  assert.ok(raw.includes("&lt;img src=x onerror=alert(1)&gt;"), "escaped actor id is present");
  // Message bodies are audit metadata, not content: they never render.
  assert.ok(!html.includes("alert(1)</script>") || html.includes("&lt;script&gt;"), "no raw body markup");
});

test("rows tolerate bare events, missing sequences, and invalid timestamps", () => {
  const bare = renderAuditRow(posted().event);
  assert.match(bare, /Posted a message/);
  const noSeq = renderAuditRow({ event: posted().event });
  assert.match(noSeq, /<code>—<\/code>/);
  const badTime = renderAuditRow(posted({ at: "yesterday-ish" }));
  assert.ok(badTime.includes("yesterday-ish"), "invalid time renders raw");
  assert.ok(!badTime.includes("<time"), "invalid time gets no datetime attribute");
  assert.equal(typeof renderAuditRow(null), "string");
  assert.equal(typeof renderAuditRow({}), "string");
});

test("the log renders every entry and names the columns", () => {
  const rows = [
    posted(),
    { sequence: 8, event: { id: "e_w", type: "work.completed", roomId: "room_1", actorId: "m_bo", at: "2026-09-16T01:00:00.000Z", data: { workItemId: "w_1" } } }
  ];
  const html = renderAuditLog(rows, { resolveName: { m_avery: "Avery Quinn", m_bo: "Bo Lin" } });
  assert.match(html, /<section class="audit-log"/);
  assert.match(html, /<th scope="col">Who<\/th>/);
  assert.match(html, /Avery Quinn/);
  assert.match(html, /Bo Lin/);
  assert.match(html, /Posted a message/);
  assert.match(html, /Completed work/);
  assert.match(html, /2 entries/);
});

test("an empty log renders the empty state, not an empty table", () => {
  const html = renderAuditLog([]);
  assert.match(html, /No audit entries yet\./);
  assert.ok(!html.includes("<table"), "no table for an empty log");
  const custom = renderAuditLog([], { emptyText: "Nothing has happened yet." });
  assert.match(custom, /Nothing has happened yet\./);
});

test("rendering is pure: inputs are never mutated", () => {
  const rows = [posted()];
  const before = JSON.stringify(rows);
  renderAuditLog(rows);
  renderAuditRow(rows[0]);
  assert.equal(JSON.stringify(rows), before);
});

test("a single entry uses the singular summary", () => {
  assert.match(renderAuditLog([posted()]), /1 entry —/);
});
