// F017 — tests for src/session-management.mjs.
//
// Covers listing enrichment (fields, current flag, age strings), revoke
// removing exactly one session, unknown-id no-ops, revokeAllExcept keeping
// the right session, input immutability across all helpers, empty-list
// edges, age/time formatting, and the renderers (escaping, current-row
// affordance, empty state). Deterministic: every time-dependent assertion
// pins `now` explicitly.

import test from "node:test";
import assert from "node:assert/strict";
import {
  formatSessionAge,
  formatSessionTime,
  listSessions,
  revokeSession,
  revokeAllExcept,
  renderSessionRow,
  renderSessionList,
} from "../src/session-management.mjs";

const NOW = 1_756_000_000_000; // fixed epoch-ms for deterministic tests

const makeSessions = () => [
  { id: "sess-1", deviceLabel: "MacBook Pro", ip: "192.0.2.10", createdAt: NOW - 30 * 86_400_000, lastSeenAt: NOW - 5 * 60_000 },
  { id: "sess-2", deviceLabel: "iPhone", ip: "203.0.113.7", createdAt: NOW - 2 * 86_400_000, lastSeenAt: NOW - 2 * 3_600_000 },
  { id: "sess-3", deviceLabel: "Linux desktop", ip: "198.51.100.44", createdAt: NOW - 86_400_000, lastSeenAt: NOW - 3 * 86_400_000 },
];

test("listSessions enriches each session", () => {
  const out = listSessions(makeSessions(), { now: NOW });
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {
    id: "sess-1",
    deviceLabel: "MacBook Pro",
    ip: "192.0.2.10",
    createdAt: NOW - 30 * 86_400_000,
    lastSeenAt: NOW - 5 * 60_000,
    current: false,
    ageMs: 5 * 60_000,
    age: "5 minutes ago",
  });
  assert.equal(out[1].age, "2 hours ago");
  assert.equal(out[2].age, "3 days ago");
});

test("listSessions flags the current session", () => {
  const out = listSessions(makeSessions(), { now: NOW, currentId: "sess-2" });
  assert.deepEqual(out.map(s => s.current), [false, true, false]);
});

test("listSessions tolerates missing fields and drops id-less rows", () => {
  const out = listSessions([{ id: "a" }, { deviceLabel: "no id" }, null, "junk"], { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].deviceLabel, "Unknown device");
  assert.equal(out[0].ip, "—");
  assert.equal(out[0].age, "just now");
  assert.equal(out[0].current, false);
});

test("listSessions handles empty and non-list inputs", () => {
  assert.deepEqual(listSessions([], { now: NOW }), []);
  assert.deepEqual(listSessions(undefined, { now: NOW }), []);
  assert.deepEqual(listSessions(null, { now: NOW }), []);
  assert.deepEqual(listSessions("nope", { now: NOW }), []);
});

test("revokeSession removes exactly one session", () => {
  const sessions = makeSessions();
  const out = revokeSession(sessions, "sess-2");
  assert.notEqual(out, sessions);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(s => s.id), ["sess-1", "sess-3"]);
});

test("revokeSession with an unknown id returns the list unchanged", () => {
  const sessions = makeSessions();
  assert.equal(revokeSession(sessions, "nope"), sessions);
  assert.equal(revokeSession(sessions, ""), sessions);
  assert.equal(revokeSession(sessions, 42), sessions);
});

test("revokeSession on an empty list returns that list", () => {
  const empty = [];
  assert.equal(revokeSession(empty, "sess-1"), empty);
});

test("revokeAllExcept keeps only the named session", () => {
  const sessions = makeSessions();
  const out = revokeAllExcept(sessions, "sess-3");
  assert.notEqual(out, sessions);
  assert.deepEqual(out.map(s => s.id), ["sess-3"]);
});

test("revokeAllExcept with an unknown or invalid keepId changes nothing", () => {
  const sessions = makeSessions();
  // Must not nuke every session on a bad id — that would log the user out
  // of the very session making the request.
  assert.equal(revokeAllExcept(sessions, "nope"), sessions);
  assert.equal(revokeAllExcept(sessions, ""), sessions);
  assert.equal(revokeAllExcept(sessions, null), sessions);
  const empty = [];
  assert.equal(revokeAllExcept(empty, "sess-1"), empty);
});

test("helpers never mutate the input list or its rows", () => {
  const sessions = makeSessions();
  const frozen = structuredClone(sessions);
  listSessions(sessions, { now: NOW, currentId: "sess-1" });
  revokeSession(sessions, "sess-1");
  revokeAllExcept(sessions, "sess-1");
  assert.deepEqual(sessions, frozen);
  // The enriched descriptors are independent copies.
  const out = listSessions(sessions, { now: NOW });
  out[0].deviceLabel = "hacked";
  out[0].id = "hacked";
  assert.equal(sessions[0].deviceLabel, "MacBook Pro");
  assert.equal(sessions[0].id, "sess-1");
});

test("formatSessionAge renders human ages", () => {
  assert.equal(formatSessionAge(0), "just now");
  assert.equal(formatSessionAge(-1), "just now");
  assert.equal(formatSessionAge(NaN), "just now");
  assert.equal(formatSessionAge(30_000), "just now");
  assert.equal(formatSessionAge(60_000), "1 minute ago");
  assert.equal(formatSessionAge(5 * 60_000), "5 minutes ago");
  assert.equal(formatSessionAge(3_600_000), "1 hour ago");
  assert.equal(formatSessionAge(23 * 3_600_000), "23 hours ago");
  assert.equal(formatSessionAge(86_400_000), "1 day ago");
  assert.equal(formatSessionAge(10 * 86_400_000), "10 days ago");
});

test("formatSessionTime renders UTC and never throws", () => {
  assert.equal(formatSessionTime(NOW), "2025-08-24 01:46:40 UTC");
  assert.equal(formatSessionTime("garbage"), "garbage");
  assert.equal(formatSessionTime(null), "1970-01-01 00:00:00 UTC"); // new Date(null) = epoch, same as F004
});

test("renderSessionRow escapes content and marks the current session", () => {
  const html = renderSessionRow({
    id: "sess-1",
    deviceLabel: "<b>evil</b>",
    ip: "10.0.0.1",
    lastSeenAt: NOW - 60_000,
    current: false,
    age: "1 minute ago",
  });
  assert.match(html, /&lt;b&gt;evil&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>evil<\/b>/);
  assert.match(html, /<code>10\.0\.0\.1<\/code>/);
  assert.match(html, /<button type="button" class="session-revoke" data-session-id="sess-1">Revoke<\/button>/);
  assert.match(html, /<time datetime="[^"]+">/);

  const current = renderSessionRow({ id: "sess-9", deviceLabel: "Mac", ip: "1.1.1.1", lastSeenAt: NOW, current: true, age: "just now" });
  assert.match(current, /aria-current="true"/);
  assert.match(current, /Current session/);
  assert.doesNotMatch(current, /<button/);
});

test("renderSessionRow tolerates malformed input", () => {
  for (const bad of [null, undefined, 42, {}]) {
    const html = renderSessionRow(bad);
    assert.ok(html.startsWith("<tr"), `renders for ${String(bad)}`);
    assert.doesNotMatch(html, /<button[^>]*data-session-id="[^"]+"/);
  }
});

test("renderSessionList renders rows, escapes the title, handles empty", () => {
  const html = renderSessionList(makeSessions(), { now: NOW, currentId: "sess-1", title: "Sessions <here>" });
  assert.match(html, /aria-label="Sessions &lt;here&gt;"/);
  assert.match(html, /3 active sessions\./);
  assert.equal((html.match(/class="session-row"/g) ?? []).length, 3);
  assert.match(html, /data-session-id="sess-2"/);
  assert.match(html, /Current session/);

  const empty = renderSessionList([], { title: "Active sessions" });
  assert.match(empty, /No active sessions\./);
  assert.doesNotMatch(empty, /<table/);

  const nonList = renderSessionList(null);
  assert.match(nonList, /No active sessions\./);
});
