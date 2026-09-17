# Growth analytics guide

Track C (agent-managed Growth Engine), slice C10. The analytics stack built on
top of the C1 event contract: how to turn the in-memory growth event stream
into summaries, push notifications, human-readable digests, window-over-window
comparisons, and declarative alert rules.

The vocabulary and privacy rules live in `docs/GROWTH-EVENT-CONTRACT.md`.
This guide covers the analytics layer only — the stack that reads from the
collector and never touches the room's event stream, storage, or schema.

## The stack in one paragraph

C1 defines the vocabulary: a small registry of growth event types
(`src/growth-events.js`, `GROWTH_EVENT_TYPES`, `defineEvent`,
`validateEvent`) with default-deny privacy rules. C2 gives it a home: an
in-memory ring-buffer collector (`src/growth-collector.js`,
`createCollector`, `record`, `query`, `stats`). C3 wires emission into the
live room path (`src/growth-emit.js`, `applyEventWithGrowth`), and C4 adds
`agent.mentioned` events from @-mentions of agent members. On top of that,
the analytics stack reads: **C5** summarizes a window (`src/growth-summary.js`,
`summarize`), **C6** fans recorded events out to subscribers
(`src/growth-fanout.js`, `createFanout`, `getGrowthFanout`), **C7** renders
summaries into text or markdown digests (`src/growth-digest.js`,
`renderDigest`), **C8** compares two windows (`src/growth-compare.js`,
`compareSummaries`), and **C9** evaluates declarative alert rules over
summaries and comparisons (`src/growth-alerts.js`, `evaluateAlerts`).

## Quick start

Every snippet imports from `src/`. The live room path already owns a
module-level collector (`growthCollector`) and fan-out hub (`growthFanout`)
in `src/growth-emit.js`; standalone scripts and tests can build their own
with `createCollector()` / `createFanout()`.

### (a) Getting the collector and fan-out hub

```js
import { growthCollector, getGrowthFanout } from "./src/growth-emit.js";

const collector = growthCollector; // module-level C2 ring buffer, live-fed
const fanout = getGrowthFanout(); // module-level C6 hub, live-fed
```

### (b) Summarizing a window

`summarize(collector, { since, until, topN })` returns a frozen summary with
`totals` (all 12 registered types, zeros included), `activityByDay`
(UTC day buckets, ascending), `topMentionedAgents` (default top 10,
`mentionCount`-weighted), `engagement` (`messages`, `reactions`, `pins`,
`mentions`, `mentionsPerMessage` — `null` when no messages), plus the
`window` and `generatedAt`. Bounds are inclusive; omitted bounds are
unbounded. Bad bounds throw — never partial garbage. An empty window yields
a zeroed summary.

```js
import { summarize } from "./src/growth-summary.js";

const today = summarize(collector, {
  since: "2026-09-15T00:00:00Z",
  until: "2026-09-15T23:59:59Z",
  topN: 5
});
console.log(today.totals["message.sent"]); // 42
console.log(today.engagement.mentionsPerMessage); // 0.31
```

### (c) Subscribing to growth events

`subscribe(filter, handler)` returns a subscription id; `unsubscribe(subId)`
removes it. Filters are a predicate function or `{ types: [...] }`.
Handlers receive the same frozen envelope the collector stored, so they
cannot mutate it. A throwing handler or filter is caught, counted in
`getHandlerFailures()`, and never breaks the other subscribers or the room
path. Envelopes are C1-validated at the door — invalid input to `notify` is
a no-op returning 0.

```js
const fanout = getGrowthFanout();
const subId = fanout.subscribe({ types: ["agent.mentioned"] }, envelope => {
  console.log(envelope.fields.mentionedAgentId, "was mentioned");
});
fanout.unsubscribe(subId);
```

### (d) Rendering a digest

`renderDigest(summary, { format })` renders a frozen C5 summary into a
human-readable string. `format` is `"text"` (default) or `"markdown"`.
Sections: header (window + generated-at), non-zero totals, daily activity
with proportional `█` bars (max width 24, non-zero days always visible),
ranked top mentioned agents, and engagement with mentions-per-message as a
percent or `"n/a"`. An empty summary renders a short "no activity in
window" digest. Deterministic.

```js
import { renderDigest } from "./src/growth-digest.js";

console.log(renderDigest(today)); // text
console.log(renderDigest(today, { format: "markdown" })); // markdown
```

### (e) Comparing two windows

`compareSummaries(current, previous)` returns a frozen comparison:
`perType` — one entry per type with `current`, `previous`, `delta`,
`pctChange`, `fromZero` (a move from zero reports `pctChange: null` —
never `NaN`/`Infinity`), and `direction` (`up`/`down`/`flat`);
`engagementShift` — the same delta shape for messages, reactions, pins,
mentions, plus `mentionsPerMessage` ratio deltas with null-ratio handling;
`topMentionedMovers` — `{ agentId, currentMentions, previousMentions, delta }`
sorted by delta desc (new agents positive, dropped agents negative);
`windows` echoes both input windows.

```js
import { compareSummaries } from "./src/growth-compare.js";

const comparison = compareSummaries(today, yesterday);
const surges = comparison.perType.filter(e => e.direction === "up");
```

### (f) Evaluating alert rules

Rules are declarative frozen objects built by `activitySurgeRule`,
`deadWindowRule`, `mentionSpikeRule`, `engagementDropRule`, or generically
via `defineRule(kind, params)`. `evaluateAlerts(rules, { summary, comparison })`
returns a frozen array of hits — one `{ ruleId, kind, triggered, severity,
detail }` per rule, triggered or not. Severities are `info`, `warn`,
`critical` with per-kind defaults. Rules that need a comparison and don't
get one report `triggered: false` with `detail: "needs comparison"`.
Rules only — no timers, no sends, no wiring.

```js
import {
  activitySurgeRule,
  mentionSpikeRule,
  evaluateAlerts
} from "./src/growth-alerts.js";

const rules = [
  activitySurgeRule({ eventType: "message.sent", pctThreshold: 0.5 }),
  mentionSpikeRule({ agentIds: ["agent-9"], countThreshold: 10 })
];
const hits = evaluateAlerts(rules, { summary: today, comparison });
hits.filter(h => h.triggered).forEach(h => console.log(h.severity, h.detail));
```

## Guarantees

- **Pure and dependency-free.** The analytics modules import only each
  other and the C1 contract module. No I/O, no network, no timers, no
  storage.
- **Frozen outputs.** `summarize`, `compareSummaries`, `renderDigest`,
  and `evaluateAlerts` return deep-frozen structures (envelopes are frozen
  at construction by `defineEvent`).
- **Fail-closed validation.** Bad windows, malformed summaries,
  unknown rule kinds, and invalid filters throw clear `Error`s — never
  partial garbage. Percent changes are never `NaN`/`Infinity`.
- **Deterministic.** Same events in, same output out. Day buckets are
  UTC; mention leaderboards break ties by agent id.
- **Privacy.** Identifier-only analytics, matching the C1 contract:
  message bodies, emails, tokens, and credentials are never collected.
  Message bodies never appear in digests.
- **Failure isolation.** Analytics never breaks the room path. Emission
  failures are counted (`getGrowthEmissionFailures`), subscriber failures
  are counted (`getHandlerFailures`), and both are swallowed away from the
  primary result.

## Explicitly unwired (future slices — do not implement here)

These are known gaps, listed so future claims don't collide:

- **Periodic evaluation timers** — nothing currently runs `summarize` /
  `evaluateAlerts` on a schedule.
- **Persistence across restarts** — the C2 collector is in-memory only;
  a snapshot/restore slice would touch storage and needs an issue #11
  proposal first.
- **HTTP/dashboard surface** — no server endpoint exposes summaries or
  digests; wiring one in touches shared `server/` code.
- **Per-room collectors** — the live path uses one module-level
  collector; room-scoped fan-out/filtering is unclaimed.

## Executable evidence

Run `node --test tests/growth-summary.test.js
tests/growth-fanout.test.js tests/growth-digest.test.js
tests/growth-compare.test.js tests/growth-alerts.test.js`. The vectors
cover window filtering and day-boundary bucketing, mention aggregation and
`topN` capping, engagement ratios, subscriber filtering and throwing-handler
isolation, digest section/bar rendering and determinism, comparison deltas
with fromZero/null-ratio handling, and every alert rule's trigger and
no-trigger paths.
