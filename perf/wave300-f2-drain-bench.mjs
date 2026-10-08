// WAVE-300 F2 benchmark (SIM): wall-clock to drain 100 fake wake
// deliveries through the real drainWebhookDeliveries code path, with an
// injected fetchImpl carrying 20 ms artificial latency per POST. No
// network, no credentials. Run before/after the F2 change and compare.
//
// Usage: TMPDIR=$PWD/.tmp node perf/wave300-f2-drain-bench.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { WAKE_PING_EVENT, buildWakePing } from "../server/outbound-webhooks.mjs";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const N = Number(process.env.F2_BENCH_N ?? 100);
const LATENCY_MS = Number(process.env.F2_BENCH_LATENCY_MS ?? 20);
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };

const dir = mkdtempSync(join(tmpdir(), "room-f2-bench-"));
const store = new RoomStore(join(dir, "room.sqlite"), { now: () => NOW });
const { subscription } = store.agentPlugin.subscribeWebhook({
  identityId: "bench-agent", url: "https://hooks.example.test/agent",
  events: [WAKE_PING_EVENT], secret: "signing-secret-0123456789abcdef",
});
// Distinct eventIds: measures dispatch parallelism, not coalescing.
for (let i = 0; i < N; i++) {
  store.agentPlugin.buildWebhookDelivery(subscription.subscriptionId, {
    eventType: WAKE_PING_EVENT,
    data: buildWakePing({ agentId: "bench-agent", signal: { signalId: `bench-evt-${i}` } }),
    eventId: `bench-evt-${i}`,
    roomId: null,
  });
}
const fetchImpl = async () => {
  await new Promise(resolve => setTimeout(resolve, LATENCY_MS));
  return { status: 200, text: async () => "ok", headers: { get: () => null } };
};
const t0 = Date.now();
const summary = await store.agentPlugin.drainWebhookDeliveries({
  fetchImpl, now: NOW, limit: N, dnsResolvers: publicDns,
});
const elapsed = Date.now() - t0;
const states = store.db.prepare(
  "SELECT state, COUNT(*) AS n FROM agent_webhook_deliveries GROUP BY state").all();
console.log(JSON.stringify({ n: N, latencyMs: LATENCY_MS, elapsedMs: elapsed,
  summary, states }, null, 2));
store.close();
rmSync(dir, { recursive: true, force: true });
