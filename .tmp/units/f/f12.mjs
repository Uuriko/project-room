// f12: plugin-store concurrent wake deliveries — 10 parallel deliverWakePing
// with the SAME signalId must journal exactly ONE delivery per target
// (idempotency_key dedupe); different signalIds each get their own rows.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const P = "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine";
const { RoomStore } = await import(P + "/server/store.mjs");

const dir = mkdtempSync(join(tmpdir(), "g11-f12-"));
const store = new RoomStore(join(dir, "room.sqlite"), { now: () => Date.now() });
const ap = store.agentPlugin;
try {
  ap.setWebhookLookup(async () => ({ addresses: ["93.184.216.34"] }));
  const { subscription } = ap.subscribeWebhook({
    identityId: "agent-f12", url: "https://wake.example/hook", events: ["agent.wake"] });
  const subId = subscription.subscriptionId;

  // 10 "concurrent" same-signal deliveries (sync mutate serializes; the
  // SELECT-then-INSERT idempotency contract must still hold).
  const results = await Promise.all(Array.from({ length: 10 },
    () => Promise.resolve().then(() =>
      ap.deliverWakePing({ identityId: "agent-f12", signal: { signalId: "sig-same" } }))));
  const rows = store.db.prepare(
    "SELECT delivery_id, idempotency_key FROM agent_webhook_deliveries WHERE event_id=?").all("sig-same");
  const dupes = results.filter(r => r.deliveries.some(d => d.duplicate)).length;
  console.log(`same-signal x10: rows=${rows.length} results_flagged_duplicate=${dupes}`);
  if (rows.length !== 1) { console.log("F12 FAIL: same signal journaled " + rows.length + " rows"); process.exit(1); }

  // 5 distinct signals -> 5 more rows.
  for (let i = 0; i < 5; i++) ap.deliverWakePing({ identityId: "agent-f12", signal: { signalId: "sig-" + i } });
  const total = store.db.prepare("SELECT COUNT(*) AS n FROM agent_webhook_deliveries").get().n;
  console.log(`distinct signals: total rows=${total}`);
  if (total !== 6) { console.log("F12 FAIL: expected 6 rows, got " + total); process.exit(1); }

  // No-subscription agent -> no deliveries, no throw.
  const none = ap.deliverWakePing({ identityId: "agent-nobody", signal: { signalId: "sig-x" } });
  if (none.deliveries.length !== 0) { console.log("F12 FAIL: phantom deliveries"); process.exit(1); }
  console.log("F12 PASS");
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
