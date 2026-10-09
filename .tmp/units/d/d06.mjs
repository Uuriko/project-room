// d06: wake delivery.
import { writeFileSync } from "node:fs";
const OUT = process.argv[2] + "/docs";
writeFileSync(OUT + "/wake-delivery.md", `# Wake delivery (guild-11 slice docs)

Source: \`AgentPluginStore.deliverWakePing({ identityId, signal })\` in
\`server/agent-plugin-store.mjs\`; payload via \`buildWakePing\` /
\`WAKE_PING_EVENT\` ("agent.wake") in \`server/outbound-webhooks.mjs\`.

## Flow

1. For every ENABLED subscription of the identity whose events include
   "agent.wake" (or "*"), journal one delivery via \`buildWebhookDelivery\`
   with \`eventId = signal.signalId\` (null when the signal has none —
   then no idempotency dedupe applies).
2. Event-push: for each DISTINCT wakeUrl of the identity's wakeable hosts
   (\`wakeUrlTargets()\` dedupes by URL), journal an additional delivery on
   the FIRST matching subscription with \`target_url\` set and
   \`idempotencySuffix = "wake-url:<hostId>"\` — so the wakeUrl row is a
   distinct journal row from the subscription-URL row.
3. If any deliveries were journaled, \`kickDispatch()\` (no-op in tests).

## Rules that matter

- No subscription -> no delivery. The heartbeat queue alone carries the wake
  in that case (deliverWakePing returns zero deliveries, never throws).
- A bad stored wakeUrl is SKIPPED, not thrown — one corrupt host must not
  break the wake path. The subscription-URL delivery still stands.
- \`wakeUrlTargets()\` never throws: missing heartbeats table (older DB)
  just means no push targets; only \`mode === "wakeable"\` hosts with a
  non-empty string wakeUrl count.
- Journal projections (\`deliveryView\`) strip payload and signature details:
  journal rows reveal \`data === undefined && payload === undefined\`.

## Concurrency

\`deliverWakePing\` runs inside \`mutate()\` (one SQLite transaction). The
idempotency-key SELECT-then-INSERT makes concurrent same-signal deliveries
collapse to one journal row (fuzz f12: 10 parallel same-signal pings -> 1
row; 5 distinct signals -> 5 more rows).

## Test anchor

tests/bonds.test.js: two wake signals (fresh + offline) x two targets
(subscription URL + host wakeUrl) = 4 journaled agent.wake deliveries, each
with \`state === "pending"\`.
`);
console.log("d06 wrote docs/wake-delivery.md");
