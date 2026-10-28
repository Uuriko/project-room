// Research r72: the operator archive's catch-up is bounded by work, not only
// by the clock. Inside a Cloudflare Durable Object Date.now() advances only
// across I/O, and the messages backfill is synchronous SQLite work, so the
// door's 15 s deadline (CATCH_UP_BUDGET_MS) cannot fire mid-call on prod:
// prod reports Server-Timing app;dur=0 for a 10 MB room snapshot and
// lastDurationMs 0 for every synchronous cron job. Without a count cap one
// dry run could replay CATCH_UP_CALLS x 1000 = 20,000 events in one request,
// past the Durable Object's 30 s CPU limit. These tests freeze Date.now the
// way prod does and check the cap holds, that progress survives the 409,
// and that repeated dry runs finish the catch-up and certify.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import * as archive from "../server/operator-archive.mjs";

const { operatorArchive } = archive;

const REQUEST = { roomId: "commons", keepNewest: 100, reason: "projection cap relief" };

function lagging(t, posts) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-r72-cap-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock, bodiesAtRest: true });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < posts; i++) {
    clock += 10_000;
    store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `m-${i}`, body: `cap fixture ${i} `.padEnd(80, "x") } });
  }
  // The replay position (state_seq): applied_seq moves only at the head.
  const applied = () => store.db.prepare("SELECT state_seq FROM messages_backfill_cursor WHERE room_id='commons'").get()?.state_seq ?? 0;
  const head = () => store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
  return { store, applied, head };
}

// Date.now() as a Durable Object sees it during synchronous work: frozen.
function freezeClock(t) {
  const frozen = Date.now();
  t.mock.method(Date, "now", () => frozen);
  return frozen;
}

test("with a frozen clock one dry run replays no more than the event cap and refuses with progress kept", t => {
  const f = lagging(t, 400);
  freezeClock(t);
  const cap = 150;
  assert.ok(f.head() > 2 * cap, `head ${f.head()}`);
  assert.throws(
    () => operatorArchive(f.store, REQUEST, "r72-cap", { eventCap: cap }),
    error => error.code === "archive_not_ready" && /backfill_not_caught_up/.test(error.message)
  );
  const after = f.applied();
  assert.ok(after > 0, "the committed prefix stays on the cursor");
  assert.ok(after <= cap, `one call replayed to seq ${after}, over the cap of ${cap}`);
  const audit = f.store.db.prepare("SELECT result, counts_json FROM operator_actions ORDER BY at, rowid").all().at(-1);
  assert.equal(audit.result, "refused");
  assert.equal(JSON.parse(audit.counts_json).detail, "backfill_not_caught_up");
});

test("repeated capped dry runs finish the catch-up, certify and plan", t => {
  const f = lagging(t, 400);
  freezeClock(t);
  const cap = 150;
  const limit = Math.ceil(f.head() / cap) + 1;
  let plan = null;
  let calls = 0;
  const seen = [];
  while (!plan && calls < limit) {
    calls += 1;
    try { plan = operatorArchive(f.store, REQUEST, `r72-cap-${calls}`, { eventCap: cap }); }
    catch (error) {
      assert.equal(error.code, "archive_not_ready", String(error?.message));
      seen.push(f.applied());
    }
  }
  assert.ok(plan, `not certified after ${calls} calls (cursor ${seen.join(" -> ")}, head ${f.head()})`);
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.ok(calls >= 3, `a ${f.head()}-event replay under a cap of ${cap} needs several calls, took ${calls}`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `progress moved forward each call: ${seen.join(" -> ")}`);
});

test("the default cap keeps one call inside the 30 s CPU limit at the slowest measured replay rate", () => {
  // r71 measured ~2.0 ms/event early and ~4.3 ms/event at 10.5k-14k events
  // locally (prod speed unverified); cloudflare/wrangler.jsonc sets cpu_ms 30000.
  const { CATCH_UP_EVENT_CAP } = archive;
  assert.equal(Number.isInteger(CATCH_UP_EVENT_CAP), true, "server/operator-archive.mjs exports CATCH_UP_EVENT_CAP");
  assert.ok(CATCH_UP_EVENT_CAP >= 1000, "at least one full backfill call per request");
  assert.ok(CATCH_UP_EVENT_CAP * 4.3 <= 30_000 * 0.6, `${CATCH_UP_EVENT_CAP} events x 4.3 ms leaves under 40% CPU headroom`);
});
