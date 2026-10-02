import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { FIXED_MS, openRoom } from "./analytics-fixture.mjs";
import { backfillFile } from "../scripts/analytics-backfill.mjs";
import { baselineReport } from "../server/analytics/metrics.mjs";
import { runAnalyticsTail } from "../server/analytics/tail.mjs";

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("backfill reports hand-counted weeks and leaves the input file unchanged", async t => {
  const { store, file } = openRoom(t);
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const before = hashFile(file);
  const { report } = await backfillFile(file, { now: FIXED_MS });
  assert.equal(hashFile(file), before);
  assert.equal(report.label, "backfilled; source unknown");
  assert.deepEqual(report.missing, ["visits", "billing"]);
  assert.equal(report.weeks.length, 12);
  assert.equal(report.weeks[0].week, "2026-07-13");
  assert.equal(report.weeks.at(-1).week, "2026-09-28");
  for (const week of report.weeks) {
    if (week.week === "2026-09-28") {
      assert.equal(week.productiveRooms, 1);
      assert.equal(week.productiveRoomsWithoutHumanRequirement, 1);
      assert.equal(week.excludedProductiveRooms, 0);
    } else {
      assert.equal(week.productiveRooms, 0);
      assert.equal(week.productiveRoomsWithoutHumanRequirement, 0);
      assert.equal(week.excludedProductiveRooms, 0);
    }
  }
  assert.deepEqual(report.funnel, [{
    week: "2026-09-28", roomsCreated: 1, withAgent: 1, withClose: 1,
    medianHoursToFirstClose: 0, p90HoursToFirstClose: 0
  }]);
  assert.deepEqual(report.signups, [{ week: "2026-09-28", origin: "github", signups: 1 }]);
  assert.equal(report.referralK.invitesSent, 0);
  assert.equal(report.referralK.converted, 1);
  assert.equal(report.referralK.activatedWithin14Days, 1);
  assert.equal(report.referralK.k, null);
  const dumped = JSON.stringify(report);
  assert.equal(dumped.includes("Leak"), false);
  assert.equal(dumped.includes("leak@example.com"), false);
});

test("an excluded room is counted beside productive rooms, including an env id applied at read time", async t => {
  const { store } = openRoom(t, { roomId: "smoke-lab", title: "Canary practice" });
  await runAnalyticsTail(store.db, { now: FIXED_MS, budgetMs: 5000 });
  const report = baselineReport(store.db, { now: FIXED_MS });
  const week = report.weeks.find(row => row.week === "2026-09-28");
  assert.equal(week.productiveRooms, 0);
  assert.equal(week.excludedProductiveRooms, 1);
  const { store: live } = openRoom(t);
  await runAnalyticsTail(live.db, { now: FIXED_MS, budgetMs: 5000 });
  const hidden = baselineReport(live.db, { now: FIXED_MS, env: { ANALYTICS_EXCLUDED_ROOMS: "alpha" } });
  const hiddenWeek = hidden.weeks.find(row => row.week === "2026-09-28");
  assert.equal(hiddenWeek.productiveRooms, 0);
  assert.equal(hiddenWeek.excludedProductiveRooms, 1);
  const flagged = live.db.prepare("SELECT props FROM analytics_events WHERE room_id='alpha'").all();
  assert.equal(flagged.some(row => JSON.parse(row.props).excluded === true), false);
});

test("the backfill command requires a database path", () => {
  const result = spawnSync(process.execPath, ["scripts/analytics-backfill.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--db/);
});
