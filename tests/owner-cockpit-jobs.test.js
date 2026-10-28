// The owner cockpit shows the scheduled-job list from /api/owner/overview,
// opened and counted when a job is past the 3-in-a-row alert line.
import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerCockpit } from "../src/owner-cockpit.js";

function fakeSection() {
  const box = () => ({ innerHTML: "", textContent: "", hidden: false, querySelector: () => null, querySelectorAll: () => [] });
  const parts = { "#cockpit-summary": box(), "#cockpit-decisions": box(), "#cockpit-exceptions": box(), "#cockpit-room-stubs": box(), h3: box() };
  return { hidden: true, parts, querySelector: selector => parts[selector] ?? null, setAttribute() {} };
}

const doc = jobs => ({
  decisions: { total: 0, waiting: 0, overdue: 0, oldestAgeMs: 0, items: [] },
  exceptions: { total: 0, items: [] }, rooms: { label: null }, roomErrors: [], jobs
});

test("the cockpit lists every job with its result, streak and times, and flags alerts", async () => {
  const section = fakeSection();
  const cockpit = createOwnerCockpit({ section, decide: async () => {}, accountClient: { ownerOverview: async () => doc([
    { name: "store-growth", result: "failing", lastRunAt: "2026-10-22T05:00:00.000Z", lastSuccessAt: "2026-10-21T01:00:00.000Z", consecutiveFailures: 3, alert: true },
    { name: "room-backup", result: "ok", lastRunAt: "2026-10-22T07:00:00.000Z", lastSuccessAt: "2026-10-22T07:00:00.000Z", consecutiveFailures: 0, alert: false },
    { name: "gmail-sync", result: "disabled", lastRunAt: null, lastSuccessAt: null, consecutiveFailures: 0, alert: false }
  ]) } });
  await cockpit.refresh();
  const html = section.parts["#cockpit-exceptions"].innerHTML;
  assert.equal(section.hidden, false, "the job list alone shows the cockpit");
  assert.match(html, /<details class="cockpit-jobs" open><summary>Scheduled jobs · 1 need attention<\/summary>/);
  assert.match(html, /data-job="store-growth" data-job-result="failing" data-job-alert="true"><strong>store-growth<\/strong> failing · 3 failed in a row/);
  assert.match(html, /last run 2026-10-22T05:00:00.000Z · last success 2026-10-21T01:00:00.000Z/);
  assert.match(html, /data-job="room-backup" data-job-result="ok" data-job-alert="false"/);
  assert.match(html, /gmail-sync<\/strong> off /);
  assert.match(html, /last run never · last success never/);
});

test("with every job healthy the list stays closed", async () => {
  const section = fakeSection();
  const cockpit = createOwnerCockpit({ section, decide: async () => {}, accountClient: { ownerOverview: async () => doc([
    { name: "room-backup", result: "ok", lastRunAt: "x", lastSuccessAt: "x", consecutiveFailures: 0, alert: false }
  ]) } });
  await cockpit.refresh();
  assert.match(section.parts["#cockpit-exceptions"].innerHTML, /<details class="cockpit-jobs" ><summary>Scheduled jobs<\/summary>/);
});
