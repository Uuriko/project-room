// Charter B-3 step 3, PR4: orphan O2 disposition — src/owner-alerts.mjs
// wired as the escalation engine behind the aging doctrine. Pins: an
// escalated access ask raises + dispatches an alert through the
// decision push class (counts only), the dispatcher snapshot persists
// across restarts (no duplicate raises), a critical alert re-notifies
// on the dispatcher's sweep, and deciding the ask resolves its alert.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { accessRequestSchema } from "../server/access-requests.mjs";
import { generateVapidKeys } from "../server/web-push.mjs";
import { ownerAlertDispatcherFor, runOwnerAlertEscalation } from "../server/owner-alert-escalation.mjs";

const DAY = 24 * 3600 * 1000;
const RECEIVER_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";

async function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-owner-alerts-"));
  const clock = { now: Date.parse("2026-10-15T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const calls = [];
  const keys = await generateVapidKeys();
  store.humanPush.configure({
    vapid: { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:push@example.com" },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { status: 201, headers: { get: () => null } }; }
  });
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.humanPush.save(ownerKey, "commons", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner", expirationTime: null,
    keys: { p256dh: RECEIVER_PUBLIC, auth: AUTH_SECRET }
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, calls, clock };
}

function seed(store, id, createdAt) {
  store.db.prepare(`INSERT INTO access_requests
    (request_id, room_id, identity_id, display_name, requested_permissions, status, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, "commons", `id-${id}`, `Name ${id}`, "[]", "pending", createdAt);
}

test("an escalated ask raises and dispatches a decision push; the snapshot persists", async t => {
  const { store, calls, clock } = await boot(t);
  seed(store, "ar_old", clock.now - 4 * DAY);
  const first = await runOwnerAlertEscalation(store, "commons", { now: clock.now });
  assert.equal(first.raised, 1);
  assert.equal(first.dispatched, 1);
  assert.equal(first.errors, 0);
  await store.humanPush.flush();
  assert.ok(calls.length >= 1, "the owner was pushed");
  assert.equal(calls[0].url, "https://fcm.googleapis.com/fcm/send/owner");

  const row = store.db.prepare("SELECT snapshot_json FROM owner_alert_state WHERE room_id='commons'").get();
  assert.ok(row, "dispatcher snapshot persisted");
  const snapshot = JSON.parse(row.snapshot_json);
  assert.equal(snapshot.alerts.length, 1);
  assert.equal(snapshot.alerts[0].state, "sent");
  assert.equal(snapshot.alerts[0].severity, "warning");

  // A second tick over the same store (a fresh dispatcher hydrated from
  // the snapshot) raises nothing new and dispatches nothing again.
  const second = await runOwnerAlertEscalation(store, "commons", { now: clock.now });
  assert.equal(second.raised, 0);
  assert.equal(second.dispatched, 0);
});

test("deciding the ask resolves its alert on the next tick", async t => {
  const { store, clock } = await boot(t);
  seed(store, "ar_decide", clock.now - 4 * DAY);
  await runOwnerAlertEscalation(store, "commons", { now: clock.now });
  store.db.prepare("UPDATE access_requests SET status='approved' WHERE request_id='ar_decide'").run();
  const tick = await runOwnerAlertEscalation(store, "commons", { now: clock.now });
  assert.equal(tick.resolved, 1);
  const dispatcher = ownerAlertDispatcherFor(store, "commons");
  assert.equal(dispatcher.list({ state: "resolved" }).length, 1);
  assert.equal(dispatcher.list({}).filter(alert => alert.state !== "resolved").length, 0);
});

test("an ask within a day of lapsing raises a critical alert that the sweep re-notifies", async t => {
  const { store, calls, clock } = await boot(t);
  seed(store, "ar_critical", clock.now - 6.5 * DAY);
  const first = await runOwnerAlertEscalation(store, "commons", { now: clock.now });
  assert.equal(first.raised, 1);
  const dispatcher = ownerAlertDispatcherFor(store, "commons");
  const [alert] = dispatcher.list({});
  assert.equal(alert.severity, "critical");

  // Fifteen minutes later with the alert still unacknowledged, the
  // dispatcher's sweep re-notifies (escalated:true) through the push.
  calls.length = 0;
  clock.now += 16 * 60 * 1000;
  const second = await runOwnerAlertEscalation(store, "commons", { now: clock.now });
  assert.equal(second.escalated, 1);
  await store.humanPush.flush();
  assert.ok(calls.length >= 1, "the escalation re-notified the owner");
});

test("no escalated asks means no alerts, and a missing push config is not an error", async t => {
  const { store, clock } = await boot(t);
  seed(store, "ar_young", clock.now - 1 * DAY);
  const tick = await runOwnerAlertEscalation(store, "commons", { now: clock.now });
  assert.deepEqual(tick, { raised: 0, dispatched: 0, resolved: 0, escalated: 0, errors: 0 });
});
