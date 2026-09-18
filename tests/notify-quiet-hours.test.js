// Quiet hours + per-connection notify schedules for the unified inbox.
// Pure tests with a controllable clock; no network, no DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { createNotifyPrefs, isQuietAt, NotifyError } from "../server/notify-prefs.mjs";

const throwsNotify = (fn, code) => assert.throws(fn, err => err instanceof NotifyError && err.code === code);

// ms epoch for a wall-clock instant in America/Los_Angeles (PDT, UTC-7).
// 2026-09-18 is a Friday; Sep is still PDT (PDT ends Nov 1, 2026).
const at = (hour, minute = 0) => Date.UTC(2026, 8, 18, hour + 7, minute);

// --- isQuietAt --------------------------------------------------------------
test("daytime window catches mid-window times only", () => {
  const qh = { start: "09:00", end: "17:00", tz: "America/Los_Angeles" };
  assert.equal(isQuietAt(qh, at(12)), true);
  assert.equal(isQuietAt(qh, at(9)), true);      // half-open: start inclusive
  assert.equal(isQuietAt(qh, at(17)), false);    // end exclusive
  assert.equal(isQuietAt(qh, at(8, 59)), false);
  assert.equal(isQuietAt(qh, at(18)), false);
});
test("overnight window wraps past midnight", () => {
  const qh = { start: "22:00", end: "07:00", tz: "America/Los_Angeles" };
  assert.equal(isQuietAt(qh, at(23)), true);
  assert.equal(isQuietAt(qh, at(2)), true);      // next local morning
  assert.equal(isQuietAt(qh, at(7)), false);
  assert.equal(isQuietAt(qh, at(12)), false);
});
test("start === end disables quiet hours", () => {
  const qh = { start: "00:00", end: "00:00", tz: "UTC" };
  assert.equal(isQuietAt(qh, at(3)), false);
});
test("defaults to UTC when tz is omitted", () => {
  const qh = { start: "09:00", end: "10:00" };
  assert.equal(isQuietAt(qh, Date.UTC(2026, 8, 18, 9, 30)), true);
  assert.equal(isQuietAt(qh, Date.UTC(2026, 8, 18, 12, 0)), false);
});
test("bad windows and zones are coded errors", () => {
  throwsNotify(() => isQuietAt({ start: "9pm", end: "07:00" }, at(12)), "invalid_notify");
  throwsNotify(() => isQuietAt({ start: "22:00", end: "07:00", tz: "Mars/Olympus" }, at(12)), "invalid_notify");
  throwsNotify(() => isQuietAt(null, at(12)), "invalid_notify");
});

// --- user quiet hours CRUD --------------------------------------------------
test("set/quietHoursFor/clear round trip", () => {
  const prefs = createNotifyPrefs();
  const set = prefs.setQuietHours("u1", { start: "22:00", end: "07:00", tz: "America/Los_Angeles" });
  assert.deepEqual(set.quietHours, { start: "22:00", end: "07:00", tz: "America/Los_Angeles" });
  assert.deepEqual(prefs.quietHoursFor("u1"), { start: "22:00", end: "07:00", tz: "America/Los_Angeles" });
  assert.equal(prefs.quietHoursFor("u2"), null);
  const cleared = prefs.clearQuietHours("u1");
  assert.equal(cleared.quietHours, null);
  assert.equal(prefs.quietHoursFor("u1"), null);
});
test("zero-length window is stored as an off switch", () => {
  const prefs = createNotifyPrefs();
  prefs.setQuietHours("u1", { start: "00:00", end: "00:00" });
  assert.deepEqual(prefs.quietHoursFor("u1"), { start: "00:00", end: "00:00", tz: "UTC" });
  assert.equal(isQuietAt(prefs.quietHoursFor("u1"), at(3)), false);
});
test("quiet-hours validation is coded", () => {
  const prefs = createNotifyPrefs();
  throwsNotify(() => prefs.setQuietHours("u1", { start: "25:00", end: "07:00" }), "invalid_notify");
  throwsNotify(() => prefs.setQuietHours("u1", { start: "22:00", end: "07:00", tz: "Nope/Zone" }), "invalid_notify");
  throwsNotify(() => prefs.setQuietHours("", { start: "22:00", end: "07:00" }), "invalid_notify");
});

// --- per-connection schedules -----------------------------------------------
test("set/connectionFor/remove connection round trip", () => {
  const prefs = createNotifyPrefs();
  const set = prefs.setConnection("u1", { connectionId: "tg-1", channel: "telegram", batching: "digest" });
  assert.equal(set.batching, "digest");
  assert.equal(set.quietHours, null);
  const read = prefs.connectionFor("u1", "tg-1");
  assert.equal(read.channel, "telegram");
  assert.equal(read.batching, "digest");
  assert.equal(prefs.connectionFor("u1", "nope"), null);
  const removed = prefs.removeConnection("u1", "tg-1");
  assert.equal(removed.connectionId, "tg-1");
  assert.equal(prefs.connectionFor("u1", "tg-1"), null);
});
test("connection quiet hours override the user window", () => {
  const prefs = createNotifyPrefs();
  prefs.setQuietHours("u1", { start: "22:00", end: "07:00", tz: "America/Los_Angeles" });
  prefs.setConnection("u1", { connectionId: "email-1", channel: "email",
    quietHours: { start: "00:00", end: "00:00", tz: "UTC" } }); // off for email
  const conn = prefs.connectionFor("u1", "email-1");
  assert.equal(isQuietAt(conn.quietHours, at(2)), false);
  assert.equal(isQuietAt(prefs.quietHoursFor("u1"), at(2)), true);
});
test("connection validation is coded", () => {
  const prefs = createNotifyPrefs();
  throwsNotify(() => prefs.setConnection("u1", { connectionId: "", channel: "telegram" }), "invalid_notify");
  throwsNotify(() => prefs.setConnection("u1", { connectionId: "x", channel: "telegram", batching: "hourly" }), "invalid_notify");
  throwsNotify(() => prefs.setConnection("u1", { connectionId: "x" }), "invalid_notify");
  throwsNotify(() => prefs.removeConnection("u1", "missing"), "invalid_notify");
});

// --- decideNotification ------------------------------------------------------
test("non-urgent pings deliver outside quiet hours", () => {
  const prefs = createNotifyPrefs();
  prefs.setQuietHours("u1", { start: "22:00", end: "07:00", tz: "America/Los_Angeles" });
  const d = prefs.decideNotification("u1", { at: at(12) });
  assert.equal(d.decision, "deliver");
  assert.match(d.reason, /outside quiet hours/);
});
test("non-urgent pings are held during quiet hours for the morning digest", () => {
  const prefs = createNotifyPrefs();
  prefs.setQuietHours("u1", { start: "22:00", end: "07:00", tz: "America/Los_Angeles" });
  const d = prefs.decideNotification("u1", { at: at(2) });
  assert.equal(d.decision, "hold");
  assert.match(d.reason, /morning digest/);
});
test("urgent (SLA-breach) notifications deliver even in quiet hours", () => {
  const prefs = createNotifyPrefs();
  prefs.setQuietHours("u1", { start: "22:00", end: "07:00", tz: "America/Los_Angeles" });
  const d = prefs.decideNotification("u1", { urgent: true, at: at(3) });
  assert.equal(d.decision, "deliver");
  assert.match(d.reason, /SLA breach/);
});
test("muted users hear nothing, even urgent ones", () => {
  const prefs = createNotifyPrefs();
  prefs.setGlobal("u1", { level: "muted" });
  const d = prefs.decideNotification("u1", { urgent: true, at: at(12) });
  assert.equal(d.decision, "muted");
});
test("per-connection digest batching holds outside quiet hours", () => {
  const prefs = createNotifyPrefs();
  prefs.setConnection("u1", { connectionId: "tg-1", channel: "telegram", batching: "digest" });
  const d = prefs.decideNotification("u1", { connectionId: "tg-1", at: at(12) });
  assert.equal(d.decision, "hold");
  assert.match(d.reason, /digest batching/);
  const other = prefs.decideNotification("u1", { connectionId: "email-1", at: at(12) });
  assert.equal(other.decision, "deliver");
});
test("connection quiet-hours override wins over the user window", () => {
  const prefs = createNotifyPrefs();
  prefs.setQuietHours("u1", { start: "22:00", end: "07:00", tz: "America/Los_Angeles" });
  prefs.setConnection("u1", { connectionId: "email-1", channel: "email",
    quietHours: { start: "00:00", end: "00:00", tz: "UTC" } });
  const d = prefs.decideNotification("u1", { connectionId: "email-1", at: at(2) });
  assert.equal(d.decision, "deliver");
  const tg = prefs.decideNotification("u1", { at: at(2) });
  assert.equal(tg.decision, "hold");
});
test("held items release when morning arrives", () => {
  const prefs = createNotifyPrefs();
  prefs.setQuietHours("u1", { start: "22:00", end: "07:00", tz: "America/Los_Angeles" });
  const night = prefs.decideNotification("u1", { at: at(2) });
  const morning = prefs.decideNotification("u1", { at: at(7) });
  assert.equal(night.decision, "hold");
  assert.equal(morning.decision, "deliver");
});
test("existing level resolution is untouched", () => {
  const prefs = createNotifyPrefs();
  prefs.setGlobal("u1", { level: "all" });
  assert.equal(prefs.resolve("u1", {}), "all");
  prefs.setRoom("u1", { roomId: "r1", level: "muted" });
  assert.equal(prefs.resolve("u1", { roomId: "r1" }), "muted");
  prefs.setThread("u1", { threadId: "t1", level: "mentions" });
  assert.equal(prefs.resolve("u1", { roomId: "r1", threadId: "t1" }), "mentions");
  assert.deepEqual(prefs.LEVELS, ["all", "mentions", "muted"]);
});
