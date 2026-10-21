import test from "node:test";
import assert from "node:assert/strict";
import { buildSetupIntro, parseSetupReport, scheduleFor, PLATFORM_SCHEDULES } from "../server/setup-intro.mjs";

test("one paste loads settings, asks for the schedule and asks for a report", () => {
  const { text, requested } = buildSetupIntro({ origin: "https://room.example.test", roomId: "launch", platform: "grok-bot" });
  assert.equal(requested, 10);
  assert.match(text, /room_needs_me/);
  assert.match(text, /activation-pack\?view=brief/);
  assert.match(text, /Routines, every 10 minutes/);
  assert.match(text, /setup\.report/);
  assert.match(text, /Report what happened, not what you intended/);
  assert.doesNotMatch(text, /Bearer|identitySecret|PROJECT_ROOM_SECRET/);
});

test("on-demand agents are told not to create a schedule", () => {
  for (const platform of ["codex", "claude-code"]) {
    const { text, requested } = buildSetupIntro({ roomId: "r", platform });
    assert.equal(requested, null);
    assert.match(text, /Do not create a recurring check/);
  }
});

test("every platform's intro fits the paste budget", () => {
  for (const platform of Object.keys(PLATFORM_SCHEDULES)) {
    assert.ok(Buffer.byteLength(buildSetupIntro({ roomId: "r".repeat(128), platform }).text) <= 1600);
  }
});

test("overrides are bounded and can turn the schedule off", () => {
  assert.equal(scheduleFor("chatgpt").minutes, 60);
  assert.equal(scheduleFor("chatgpt", "off").minutes, null);
  assert.equal(scheduleFor("muse", 120).minutes, 120);
  assert.throws(() => scheduleFor("muse", 1));
  assert.throws(() => scheduleFor("muse", "soon"));
  assert.match(buildSetupIntro({ roomId: "r", platform: "claude", scheduleMinutes: 120 }).text, /every 2 hours/);
  assert.throws(() => buildSetupIntro({ roomId: "bad id" }));
});

test("a schedule counts as saved only with a real interval, and failures need a reason", () => {
  assert.deepEqual(parseSetupReport({ scheduleSaved: true, intervalMinutes: 60 }).report, { scheduleSaved: true, intervalMinutes: 60, limitation: null });
  assert.equal(parseSetupReport({ scheduleSaved: true }).ok, false);
  assert.equal(parseSetupReport({ scheduleSaved: false }).ok, false);
  const failed = parseSetupReport({ scheduleSaved: false, intervalMinutes: null, limitation: "Plus plan\nhas no tasks" });
  assert.equal(failed.report.limitation, "Plus plan has no tasks");
  assert.equal(parseSetupReport({ scheduleSaved: "yes" }).ok, false);
  assert.equal(parseSetupReport({ scheduleSaved: true, intervalMinutes: 2 }).ok, false);
  assert.equal(parseSetupReport([]).ok, false);
});

test("the /a/<code> page ends with the setup intro when it fits, and sheds it when it does not", async () => {
  const { renderAgentConnectMarkdown } = await import("../server/routes/agent-connect.mjs");
  const args = { origin: "https://room.example.test", code: "RM-abc123XYZ", roomId: "launch", title: "Launch", purpose: "", profile: "contribute", permissions: [], expiresAt: Date.now() + 600000, claims: [] };
  const short = renderAgentConnectMarkdown(args);
  assert.match(short, /## 4\. Finish setup/);
  assert.match(short, /setup\.report/);
  assert.ok(Buffer.byteLength(short) <= 3072);
  const full = renderAgentConnectMarkdown({ ...args, title: "x".repeat(120), purpose: "y".repeat(400), claims: [{ id: "c1", title: "z".repeat(120), assigned: true }, { id: "c2", title: "w".repeat(120), assigned: false }] });
  assert.ok(Buffer.byteLength(full) <= 3072);
  assert.match(full, /identitySecret/);
});

test("the report is read from a room message that starts with setup.report", async () => {
  const { setupReportFromMessage } = await import("../server/setup-intro.mjs");
  assert.deepEqual(setupReportFromMessage('setup.report {"scheduleSaved": true, "intervalMinutes": 10}').report, { scheduleSaved: true, intervalMinutes: 10, limitation: null });
  assert.equal(setupReportFromMessage("setup.report {nope}").ok, false);
  assert.equal(setupReportFromMessage("hello setup.report {}"), null);
  assert.equal(setupReportFromMessage(null), null);
  assert.equal(setupReportFromMessage("setup.report " + "x".repeat(3000)), null);
});

test("the compact intro shows on hosted invite pages with real room context", async () => {
  const { renderAgentConnectMarkdown } = await import("../server/routes/agent-connect.mjs");
  const base = { origin: "https://room.trydemigod.com", code: "RM-0123456789ABCDEF", roomId: "muse-room", profile: "contribute", permissions: [], expiresAt: Date.now() + 86400000, claims: [] };
  for (const extra of [{ title: "", purpose: "" }, { title: "Muse room", purpose: "Ship Project Room with the agents that use it." }]) {
    const page = renderAgentConnectMarkdown({ ...base, ...extra });
    assert.match(page, /## 4\. Finish setup/, JSON.stringify(extra));
    assert.match(page, /setup\.report \{/);
    assert.ok(Buffer.byteLength(page) <= 3072);
  }
});
