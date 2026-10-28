# Simplify, October 2026

Design for six structural cuts from the 2026-10-24 simplification audit. Docs only. No code in this change.

Read against `main` at `df2966d86` (2026-10-24). The audit measured `c4d15d6aa`. The two commits in between (`#4586`, desktop recovery) do not touch `server/`, `cloudflare/room.mjs`, the journals, or the MCP catalog, so the line numbers below match both trees.

The audit numbered these as items 4, 5, 6, 10, 7, and 8. This doc uses the request's numbers:

| # | Cut |
|---|---|
| 5 | One call per fast background job, with a durable outcome per job |
| 6 | Break the import cycles through `server/store.mjs` |
| 7 | Finish splitting `server/http.mjs` into area modules behind the one route table |
| 8 | One shared journal implementation for the table journals |
| 9 | MCP tools as generated adapters over the REST functions, ~15 core tools by default |
| 10 | One Durable Object per room, directory stays `invite-only-pilot` |

Audit items 1–3 (unreferenced scripts, archive weight, the browser-check list) and item 9 (one `server/config.mjs` for the env names) are out of this doc. They can land on their own and do not block the waves below.

Each cut has a current state, a target, PR-sized steps that keep `main` green and production compatible, a rollback, tests, open-PR collisions, and an expected line change. Production compatible means: current clients, current data, and current backups keep working on the deploy that contains the step. A step that changes behavior is behind a default-off switch until a later step flips it.

## 5. One call per fast job

### Current state

Every request and every job addresses one Durable Object: `env.ROOM.getByName('invite-only-pilot')` (`cloudflare/room.mjs:648`, `:661`, `:703`, `:715`, `:757`). The class comment states the contract this cut does not change: one pilot workspace per object, because account and session ownership spans rooms (`cloudflare/room.mjs:95-96`).

`server/jobs.mjs` is the registry (`JOBS` at `:299`, 920 lines). `defineJob` defaults `slow: false` (`:245-254`). Four jobs set `slow: true`: `retention` (`:386`), `integrity` (`:398`), `room-backup` (`:527`), `store-growth` (`:582`). The Worker fast jobs are `gmail-sync`, `channel-drain`, `webhook-dispatch`, `land-queue`, `claim-prs`, `public-read-model`, `public-work-reseed`, `escrow-epochs`, and `patrol`. `growth-watch` is Node-only (`:569-573`).

Slow jobs already run as their own RPC. `scheduled` calls `ensureJobAlarm` once, then `runSlowJob(name)` per slow job, and takes a fresh stub after a failure (`cloudflare/room.mjs:746-766`, `runSlowJob` at `:546-552`). That split landed in `#4581` (merged 2026-10-24, branch `codex/cron-isolation-1024`). There is no open PR and no tree reference for `grok/slow-job-durable-outcomes`. `#4581` is the landed form of that work. Do not reopen it.

Fast jobs still share one invocation. `alarm` calls `#runDueJobs({ includeSlow: false })`, which loops every due fast job (`cloudflare/room.mjs:555-559`, loop at `:499-508`). `ensureJobAlarm` does the same batch before it arms the next alarm (`:536-542`). Inside the loop, `recordCronTick` runs before the next job starts (`:504-506`), and `runCronJobs` catches a throw per job (`cloudflare/job-heartbeat.mjs:124-158`). A failed outcome still fails the whole alarm: `alarm` throws, sets a one-minute retry (`ALARM_RETRY_MS` in `server/jobs.mjs:36`), and re-arms in `finally` (`cloudflare/room.mjs:560-570`).

The heartbeat record is one Durable Object storage value (`recordCronTick`, `cloudflare/room.mjs:251-285`), folded per job by `applyOutcomes` (`cloudflare/job-heartbeat.mjs:162`). The channel drain's completed summary still sits in instance fields until that put confirms it (`cloudflare/room.mjs:291-305`, `:376-385`). A reset during the batch can drop a summary the put has not committed, and the in-flight drain stamp is the one durable exception (`CHANNEL_DRAIN_INFLIGHT_KEY`, `:324-340`).

Readiness is `SELECT 1` on that same object, bounded by `HEALTH_PROBE_TIMEOUT_MS` of 1000 (`cloudflare/health-probe.mjs:9-12`, used at `cloudflare/room.mjs:699-701`). A probe that misses the window answers 503. An alarm that runs every due fast job holds the object's input gate for the whole batch, so a slow tick is a readiness 503 for every room.

### Target

`alarm` runs one due fast job, commits that job's outcome, and re-arms for the next due time. The `*/30` safety-net cron calls `runFastJob(name)` once per due fast job, the same shape as `runSlowJob`. Each call returns only after `recordCronTick`'s `storage.put` resolves. A failed job retries itself. Jobs that already committed are not run again by that failure.

The heartbeat stays one map of per-job records. Splitting it into one storage key per job is a different change and collides with `#4562`, which reads this map. Durability here is the call boundary: the put finishes before the RPC returns.

Job names, cadences, enable rules, the public `/api/health/jobs` shape, and the Node scheduler stay. `growth-watch` stays on Node.

### Migration

Each step is its own PR. Behavior of a deployed Worker matches `main` until step 5b.

1. **`runFastJob` exists and nothing calls it from `alarm`.** Add the method beside `runSlowJob` (`cloudflare/room.mjs:546`). It calls `#runDueJobs({ includeSlow: false, onlyJob: name })` and returns the outcomes already passed through `recordCronTick`. Reject unknown names the way `runSlowJob` rejects an unknown slow job (`:547-548`). `alarm` and `ensureJobAlarm` stay batch callers. Production is unchanged because the cron never calls the new method.
2. **`alarm` runs the earliest due fast job only.** After the put, `#armJobAlarm` schedules the next job. A failure sets `ALARM_RETRY_MS` for that job and still re-arms. `scheduled` loops due fast jobs through `runFastJob`, each on its own RPC, and continues after one failure the way it already continues after a slow-job failure (`:761-764`). `ensureJobAlarm` arms the alarm and does not itself run the batch. The safety-net cron remains `*/30 * * * *` (`server/jobs.mjs:34`, `cloudflare/wrangler.jsonc:29`).
3. **Channel-drain outcome commit.** The drain RPC's returned summary is the value `recordCronTick` persists before `runFastJob` returns. The in-memory stash (`channelDrainOutcome`, `:376-385`) remains the peek for a drain that is still in `waitUntil`, and the inflight storage key stays. This step only removes the window where a completed drain summary exists solely in instance memory across an RPC return.

### Rollback

1. Delete `runFastJob`. No stored data uses it.
2. Restore the batch in `alarm` and `ensureJobAlarm`. The heartbeat map written by step 2 is the same `applyOutcomes` shape `main` writes, so a rollback deploy reads it.
3. Restore the stash-until-put sequence. In-flight drain stamps from step 3 are the same key `main` already deletes in `finally` (`:369-373`).

No step migrates SQLite. No step changes a job's SQL.

### Tests

Extend the fixtures that already drive the alarm and the cron RPC:

- `cloudflare/jobs-alarm.test-fixture.mjs` and `cloudflare/jobs-alarm.check.mjs`: an alarm invocation runs one job; the next alarm runs the next due job; a failure re-arms that job without marking a sibling as run.
- `cloudflare/cron-isolation.test-fixture.mjs`: the safety net still reaches a later fast job when an earlier `runFastJob` throws, and the earlier job's heartbeat record is present on a fresh stub.
- `tests/job-heartbeat.test.js`: `applyOutcomes` shape unchanged, including an unobserved channel-drain tick (`cloudflare/job-heartbeat.mjs:167-173`).
- `npm run verify:affected` for the diff. A change to `cloudflare/room.mjs` job scheduling is a write-path change in the sense of `AGENTS.md` only if it changes store writes. These steps do not. The room bench is not required for 5a–5c.

Production smoke after the 5b deploy: `GET /api/ready` and `GET /api/health/jobs` on `room.trydemigod.com`. A 503 on ready during a quiet minute means the alarm is still holding the object; roll 5b back.

### Collisions and order

Land or rebase onto these before step 5b, because they edit the same functions:

| PR | What it touches | Order |
|---|---|---|
| `#4581` | Merged. Slow jobs are already per RPC | Do not redo |
| `#4573` | `server/jobs.mjs` store-growth summary (`reliefCounts` onto the flat heartbeat) | Before any edit to the `store-growth` job body. 5b does not need that body. Rebase if both touch `jobs.mjs` imports |
| `#4562` | `cloudflare/room.mjs` `recordCronTick` and the owner-overview snapshot; `server/http.mjs` | Before 5c. Keep `jobHealthSnapshot` if `#4562` has landed |
| `#4560` | `server/jobs.mjs` database size read | Before editing `measureStoreGrowth` |
| `#4561` | `server/jobs.mjs` 8 GB / 3.5 MiB alert | Same file as `#4560` and `#4573`. Let those three land, then 5 |
| `#4575` | `cloudflare/room.mjs` backup-token split | Before 5b if both diffs touch `scheduled` or `fetch` |

`#4568`, `#4587`, `#4566`, `#4556`, `#4555` are laptop and local-job work. Item 5 does not edit `machine/`, `client/evolution/`, or the Node-only `growth-watch` body.

There is no open PR on `grok/slow-job-durable-outcomes`.

### Lines removed

About 100 lines net. The batch loop, the "fail the alarm if any job failed" aggregator, and the duplicated run inside `ensureJobAlarm` come out (`cloudflare/room.mjs:489-571`). `runFastJob` is a short sibling of `runSlowJob`. Job implementations in `server/jobs.mjs` stay.

## 6. Break the cycles through `server/store.mjs`

### Current state

`server/store.mjs` is 6,851 lines and statically imports 125 local modules. A madge-style walk (record a cycle when depth-first search hits a module still on the stack, and do not re-enter a finished module) over `server/`, `cloudflare/`, and `src/` at this tree finds **61 cycles: 58 through `server/store.mjs`, plus three others**. The audit's `madge --circular` reported 51. The difference is the walker, not a different graph: both counts are "almost all through `store.mjs`", and both include `server/mcp-http.mjs` ↔ `server/mcp-discovery.mjs`.

Of the 58, **31 are direct two-cycles**. The usual back edge is `import { ServiceError } from "./store.mjs"` (or `PILOT_LIMITS` / `activeMemberCount` from the same module) while `store.mjs` imports that file to construct it. Examples: `server/reminders.mjs:4`, `server/inbox.mjs:8`, `server/needs-me.mjs:28`, `server/moderation.mjs:19`, `server/wake-queue.mjs:17`, `server/referrals.mjs:21`. `ServiceError` already lives in `server/service-error.mjs`. `store.mjs:21-31` re-exports it so existing `instanceof` checks keep one class identity.

Longer cycles use the same back edge one hop away. The audit's example is real: `store.mjs` imports `server/messages-store.mjs:53`, which imports `closeKeepSet` from `server/open-questions.mjs:3`, which imports `ServiceError` from `store.mjs:12`.

One strongly connected component contains `store.mjs` and 74 other modules. 66 of those are imported by `store.mjs` or import it.

The three cycles that do not go through `store.mjs`:

- `server/mcp-http.mjs:14` imports `livePublicMcpTools` from `server/mcp-discovery.mjs`, and `server/mcp-discovery.mjs:9` imports `MCP_JOIN_TOOLS` from `server/mcp-http.mjs`.
- `src/events.js` ↔ `src/work-reducers.js` ↔ `src/work-packet.js`.
- `server/channel-adapters/telegram-rotation.mjs` ↔ `server/channel-import.mjs`.

`store.mjs` also imports feature objects and calls them during boot: `this.referrals`, `this.reminders`, `this.moderation`, `this.wakeQueue`, `this.inbox` (`server/store.mjs:1421-1450`) and their `verifySchema` calls (`:1495-1538`). Two narrower registries already exist: `registerWriter` (`server/writer-fence.mjs:586`) and `registerTransactionRunner` (`server/spend-grants.mjs:224`).

565 test files under `tests/` construct `RoomStore` with `new RoomStore(...)`. There is no test preload (`package.json` `"test": "node --test"`). A design that requires every test to import a boot file first is not a small step.

### Target

`store.mjs` imports no feature module. Feature modules import no symbol from `store.mjs`.

Shared types live in modules that import neither: `ServiceError` (done), and `PILOT_LIMITS`, `activeMemberCount`, and `provisionalAccountPrefix` (moved).

One registry module, `server/store-features.mjs`, exports `registerFeature({ name, schemas, attach, verify })` and `attachFeatures(store)`. A single list module imports the feature modules and registers them. `store.mjs` imports only that list. The list's modules do not import `store.mjs`, so the static cycle is gone. `new RoomStore` keeps working because the list is a static import of `store.mjs`, loaded as part of evaluating `store.mjs`, from modules that no longer point back.

Messages, the event log, and the projection stay direct imports. They are the store. `messages-store.mjs` stays imported once `open-questions.mjs` no longer imports `store.mjs`.

Hooks cover the calls `store.mjs` makes into features during `command` and verify: the feature's `attach` puts `store.inbox` and the rest in place, and `verify` runs the schema check the constructor runs today. Store code calls `store.inbox` the way it does now.

Left in place: the `src/events.js` triangle and the telegram-rotation pair. They are not the store cycle.

After the steps below, a repeat of the same walk should show no cycle through `store.mjs` and no `mcp-http` ↔ `mcp-discovery` cycle. The audit's "~5" is this remainder, not a promise to delete the events triangle.

### Migration

1. **Retarget `ServiceError` imports.** Every `import { ServiceError } from "./store.mjs"` becomes an import from `./service-error.mjs`. `store.mjs:31` keeps the re-export so a missed caller still sees the same class. This PR does not move construction. It breaks the 31 direct cycles and the `open-questions` hop. `instanceof ServiceError` stays valid because it is the same class the re-export already binds (`store.mjs:21-26`).
2. **Move the pilot-limit symbols.** New `server/pilot-limits.mjs` owns `PILOT_LIMITS` (`store.mjs:451`), `activeMemberCount`, and `provisionalAccountPrefix`. `store.mjs` re-exports them. Repoint `server/guest-invites.mjs`, `server/share-links.mjs`, `server/referrals.mjs`, `server/access-requests.mjs`, `server/agent-invites.mjs`, `server/usage-summary.mjs`, `server/work-claim-events.mjs`, `server/work-claim-integrity.mjs`, `server/guest-agent-links.mjs`, `server/room-lifecycle.mjs`. Values stay identical, including `projectionBytes: 4 * 1024 * 1024`.
3. **Registry and list, one feature group per PR.** Add `server/store-features.mjs` and `server/store-feature-list.mjs`. Move construction in this order, each its own PR: reminders, moderation, wake-queue, referrals, then inbox (the largest back edge: `server/inbox.mjs` is 1,522 lines and imports `store.mjs` at `:8`). Each PR: the feature file exports a descriptor, the list registers it, `store.mjs` drops that import and the matching `verifySchema` block, `attach` assigns the same `this.*` property. Public methods on `RoomStore` that forward to the feature stay as one-line forwards so callers do not change.
4. **Break the MCP pair.** Move `MCP_JOIN_TOOLS` out of `server/mcp-http.mjs:22-47` into a module neither side owns, and point `mcp-http.mjs:14` and `mcp-discovery.mjs:9` at modules that do not import each other. Catalog bytes stay the same. This is the cycle the audit named beside store. Item 9 later generates adapters; this step only cuts the cycle.
5. **Cycle gate.** A small test walks the same static graph and fails if `server/store.mjs` appears in a cycle or if `mcp-http.mjs` and `mcp-discovery.mjs` import each other. Run it in `npm test`. It replaces a manual madge run.

`needs-me.mjs` is imported by `store.mjs:78` for `roomAttention` on the digest path. It moves in its own PR after step 1, same descriptor shape. It does not need the inbox move to go first.

### Rollback

Each PR reverts independently. Step 1 and 2 are import edits with re-exports left in place, so a partial deploy is the same class and the same numbers. Step 3's revert puts the import and the `verifySchema` call back. No schema change, no SQLite write change. A reverted feature descriptor does not leave a row behind.

### Tests

`npm run verify:affected` after each PR, then `npm test` on the PR that adds the cycle gate. Focused files for the early steps: `tests/reminders` coverage already in the suite, `tests/inbox` and `tests/needs-me` suites, `tests/invitation-journal.test.js` (store boot still replays the journal). The cycle-gate test is new and asserts the graph, not a private function layout.

No bench. These PRs do not change command execution.

### Collisions and order

Any open PR that edits `server/store.mjs` conflicts with steps 2–3. Confirmed on 2026-10-24:

| PR | Overlap | Order |
|---|---|---|
| `#4578` | `server/store.mjs` and `server/routes/table.mjs` (presence route) | Land `#4578` before the store PRs, or rebase. Do not edit `server/routes/agent-presence.mjs` |
| `#4551` | `server/store.mjs` plus MCP catalog files | Land before step 3. Item 9 waits on it separately |
| `#4568` | Draft. `server/store.mjs` plus `client/evolution/` | Rebase step 3 onto it. Do not edit `client/evolution/` |
| `#4573`, `#4560`, `#4561` | `server/jobs.mjs`, not `store.mjs` | Parallel with item 6 once item 5's rule is respected |

Step 4 collides with `#4445` (`server/mcp-http.mjs`) and with item 9's catalog PRs (`#4415`, `#4551`, `#4577`). Do step 4 after `#4445`, or limit it to extracting the constant if `#4445` is still open and does not touch `MCP_JOIN_TOOLS`.

Item 6 does not edit `server/http.mjs`, so it can proceed beside item 7.

### Lines removed

About 250 lines net. `store.mjs` drops the feature imports and the matching construct-and-verify blocks (the block around `:1421-1538` is the start). The registry, the list, and the descriptors add about 150 lines. The win is the 58 cycles, not the line count.

## 7. Split `server/http.mjs` behind the one route table

### Current state

`server/http.mjs` is 5,455 lines. The route table already exists. `server/routes/table.mjs` freezes `ROUTES` (124 rows at this tree, `:57-58`) from area modules under `server/routes/`. `server/routes/dispatch.mjs` compiles that table and answers 405 with `Allow` for a known path. `createRoomServer` calls `dispatchRoute` at `server/http.mjs:1243-1259`. A match returns. Everything else falls through "to the legacy chain below until that chain is empty" (`:1235-1238`).

That chain is about 4,200 lines (`:1260` through end of file). It still matches by hand. Examples that are still in the chain, not in `ROUTES`:

- Google and GitHub sign-in and the OAuth authorization server (`:1275`, `:1455`, `:1568-1805`).
- Public receipts (`:2101-2103`).
- Owner overview (`:2366`).
- Bounty and credit routes: the matchers at `:3903-3933` and the call to `handleBountyEscrow` at `:4271-4295`.
- Work-claim dispatch still called from the chain at `:4179` (`handleWorkClaims`), beside rows that have already moved to `server/routes/work-claims.mjs`.

`assertRouteRow` requires `id`, method, path, `auth`, `capability`, `handler`, `schema`, `events`, `scope`, and a `parity` note of `mcp:<tool>` or `exempt:<reason>` (`server/routes/table.mjs:60-84`). `tests/route-table-parity.test.js` and `tests/route-parity-notes.test.js` keep that honest. `ctx.pipeline` is off in production, so a row's `auth` column is documentation unless the handler enforces it (`server/routes/dispatch.mjs:14-17`). Extracted handlers must keep their own auth checks.

Areas already extracted include auth, inbox, agents, work claims, spend, squads, code drops, and wake status (`server/routes/table.mjs:8-29`). The legacy chain is the rest of rooms, work, agents, auth, and admin.

### Target

`http.mjs` keeps the server shell: origin check, rate limit, body read, session helpers, the `dispatchRoute` call, and the fallback 404. Area modules own the paths. One table, `ROUTES`. No second router.

The areas match the request, mapped onto files that already exist where they do:

| Area | Module | What moves out of the chain |
|---|---|---|
| Auth | `server/routes/auth.mjs` and a new `server/routes/oauth-server.mjs` | Google, GitHub, OAuth authorize/token/revoke |
| Rooms | `server/routes/rooms.mjs` | Messages, events, snapshot, search, export, owner overview |
| Work | `server/routes/bounties.mjs`, existing `work-claims.mjs` | Bounty and credit matchers; the remaining `handleWorkClaims` call |
| Agents | existing `server/routes/agents.mjs` | Identity, invite, and access-request matchers still in the chain |
| Admin | `server/routes/admin.mjs` | Operator and owner routes still in the chain |

Handlers move. Status codes, error codes, and auth checks move with them. A path that the table matches is not also matched in the chain.

### Migration

One area per PR. The first PR in an area adds rows and deletes only the matchers it adds. The chain keeps everything else.

1. **Bounties and credits.** New `server/routes/bounties.mjs`. Move the matchers at `http.mjs:3903-3933` and the `handleBountyEscrow` call at `:4271-4295` into row handlers. The handler stays `handleBountyEscrow` from `server/bounty-escrow-routes.mjs`. Same paths, same `escrowRoute` names.
2. **OAuth authorization server.** After `#4445`. Move `:1568-1805` into `server/routes/oauth-server.mjs`. Session and CSRF checks stay inside the handlers, as `dispatch.mjs` requires while `pipeline` is unset.
3. **Public receipts.** After `#4552`. Move the `:2101` block. Rows call the same `publicReceiptById` path.
4. **Owner and admin.** After `#4562`. Move `/api/owner/overview` (`:2366`) and the operator routes that remain in the chain.
5. **Rooms.** The large remainder: room read and command paths. Several PRs sliced by path prefix (`/api/rooms/{roomId}/messages`, then events, then the command POST), each deleting only its matchers.
6. **Agents remainder.** Identity and invite matchers not already in `server/routes/agents.mjs`. Skip `server/routes/agent-presence.mjs` from `#4578`.
7. **Delete the fallthrough comment's excuse.** When a test asserts no legacy matcher remains for `/api/`, the "falls through" comment goes away. Health and version routes (`:1260-1268`) can stay in the shell or become rows in that last PR.

Every PR: `assertRouteTable` already runs at import (`server/routes/dispatch.mjs:21`). A bad row fails boot, which fails tests, which keeps `main` red rather than shipping a silent 404. That is the point of landing one area at a time.

### Rollback

Revert the PR. Rows disappear with the module import in `table.mjs`, and the chain matchers return. No data change. A deploy of a subset of areas is the supported state: the table wins when it matches, the chain serves the rest (`http.mjs:1235-1259`).

### Tests

`tests/route-table-parity.test.js` and `tests/route-parity-notes.test.js` on every PR. The existing HTTP test for that area stays the behavior contract. For bounties that is `tests/bounty-escrow-http.test.js` and `tests/bounty-escrow-routes.test.js`. For receipts, the public-receipt tests `#4552` is already extending. `npm run verify:affected` plus `npm run lint`.

No bench. Routing edits must not change SQL.

### Collisions and order

| PR | Overlap | Order |
|---|---|---|
| `#4445` | `server/http.mjs`, `server/mcp-http.mjs` | Before the OAuth area. Other areas can land beside it only by rebasing; prefer waiting, then taking bounties first |
| `#4562` | `server/http.mjs` owner overview | Before the admin area |
| `#4578` | `server/routes/table.mjs`, new presence route | Rebase any table edit onto it. Do not touch the presence file |
| `#4552` | `server/receipts-live.mjs`, `server/public-read-model.mjs`, `server/public-visibility.mjs`. Does not edit `http.mjs` | Before the receipts area |
| `#4577` | MCP and `server/agent-plugin-routes.mjs` | Item 9, not this split, unless an agents PR moves plugin routes |
| `#4401` | `server/bounty-escrow.mjs` | The bounty route PR calls `handleBountyEscrow` and does not need to edit `bounty-escrow.mjs`. Rebase if it does |

`#4574` and the other claim-board PRs edit claim projection and tests more than `http.mjs`. The work-claims extraction PR rebases if `handleWorkClaims`'s arguments change.

### Lines removed

Little net deletion. About 4,000 lines move out of `http.mjs` into area modules. Expect about 200 lines net removed where a chain matcher and a comment duplicated a row. `http.mjs` itself should end near the shell plus helpers, well under 2,000 lines, once step 7 lands.

## 8. One shared journal

### Current state

Seven `server/*-journal.mjs` modules, 1,237 lines:

| File | Lines | What it actually is |
|---|---|---|
| `server/channel-journal.mjs` | 155 | Table `pending_channel_updates`. Status pending → imported or failed. Class `ChannelUpdateJournal` |
| `server/invitation-journal.mjs` | 134 | Table `membership_invitation_journal`. Append-only, hash chain, no-update and no-delete triggers (`:33-36`) |
| `server/jev-shadow-journal.mjs` | 233 | Table `jev_shadow_decisions`. Append-only shadow scores |
| `server/membership-delegation-journal.mjs` | 153 | Hash-chain table plus a pending table fed by triggers (`:7-33`) |
| `server/sla-breach-journal.mjs` | 145 | Table `sla_breach_alerts`. Idempotent receipts |
| `server/spam-quarantine-journal.mjs` | 226 | Table `spam_quarantine`. Status held → released or dismissed |
| `server/graph-reply-journal.mjs` | 191 | No `CREATE TABLE`. Pure transitions: `validateReplyAttempt` (`:16`), `transitionReplyAttempt` (`:134`) |

Sum of the six table modules: 1,046. `graph-reply-journal.mjs` is a transition module that shares the filename shape and the `ServiceError` import (`:6`).

`store.mjs` imports the schemas and classes (`:47`, `:79`, `:81`, `:84`, `:91`). The comments in the channel, SLA, and spam modules say the same thing: additive tables, writes go through the store transaction, and the recovery audit's table list is the integrity gate (`server/channel-journal.mjs:12-15`, `server/sla-breach-journal.mjs:18-21`, `server/spam-quarantine-journal.mjs:11-14`).

Replay refuses an export table the target store does not have (`server/room-export.mjs:539`), except `REPLAY_SKIPPED_TABLES` (`:490-495`). A new physical table, or a dropped old one, fails restore of existing backups.

`client/setup-journal.mjs` and `client/watch-journal.mjs` are not these modules. They stay.

### Target

One `server/journal.mjs` implements the two write modes the tables already use:

- **Append**, optional hash chain, optional no-update / no-delete triggers (invitation, membership delegation, jev shadow, SLA).
- **Status row**, with a legal transition map (channel pending/imported/failed, spam held/released/dismissed).

A kind module supplies the table name, the column checks, and the limits object that module exports today (`channelJournalLimits`, `spamQuarantineLimits`, and the rest). Existing classes (`ChannelUpdateJournal`, and the journal functions store already calls) become thin wrappers so `store.mjs` call sites do not change in the first PRs.

Table names and columns stay. This is a code merge. A later physical merge into one generic table is out of scope: it would make current backups name tables a new store does not have, which is the failure at `room-export.mjs:539`.

`graph-reply-journal.mjs` stays a transition module. It can move next to the kind files and drop the `-journal` name in a rename PR. It does not go through the append engine.

### Migration

1. **Add `server/journal.mjs` with no callers.** Append and status helpers, tested against in-memory tables created in the test. Production imports nothing new. Green by being unused.
2. **Channel kind.** `ChannelUpdateJournal` methods call the helper. Schema string `channelJournalSchema` stays byte-identical. `tests/channel-journal.test.js` and `tests/channel-journal-parity.test.js` stay.
3. **Spam kind.** Same, with `tests/spam-quarantine-journal.test.js`. Status transitions stay in the kind, executed by the helper.
4. **SLA and jev shadow.** Append mode. `tests/jev-shadow-journal.test.js` stays. SLA tests in the suite stay the contract.
5. **Invitation and membership delegation.** Hash chain and triggers stay in the schema strings those modules export. The helper gains the hash step invitation already does in `invitationJournalEntry` (`server/invitation-journal.mjs:103`). `tests/invitation-journal.test.js` stays. Delegation triggers are the risky part: the PR copies them verbatim and asserts `sqlite_master.sql` equality the way `ChannelUpdateJournal.verifySchema` already normalizes SQL (`server/channel-journal.mjs:49-57`).
6. **Delete the duplicated method bodies.** Wrappers remain if `store.mjs` still constructs the classes. After item 6's registry, the wrappers can go in a follow-up. That follow-up is sequenced after item 6 step 3 so the two PRs do not both rewrite the import block.
7. **Rename `graph-reply-journal.mjs` only if a PR is touching it anyway.** Not required for the line cut. `tests/graph-reply-journal.test.js` and `tests/graph-reply-update-journal.test.js` move with the file.

Bounty "journals" (`tests/bounty-journal-replay.test.js`) are the escrow ledger inside `server/bounty-escrow.mjs`. They are not one of the seven files. Leave them. `#4401` is already editing that ledger.

### Rollback

Steps 2–5 are reversible per kind: the class methods inline again, the helper stays until the last kind leaves, then step 1 reverts. Schema SQL does not change, so a rollback deploy opens the same database. No backfill.

### Tests

The files named in the steps, plus `npm run verify:affected`. Step 5 includes a schema-string equality check against the SQL checked in on `main`. Restore tests (`tests/room-backup-export.test.js`) should be in the affected set if a schema string changes; the point of the design is that it does not.

### Collisions and order

The journal files are not on the open PR list checked for this doc (`#4573`, `#4562`, `#4578`, `#4577`, `#4552`, `#4415`, `#4445`, `#4401`). `#4401` edits `server/bounty-escrow.mjs`, which this cut does not.

Item 6 step 1 edits the `ServiceError` import in `graph-reply-journal.mjs:6`, `channel-journal.mjs:17`, `sla-breach-journal.mjs:22`, and `spam-quarantine-journal.mjs:21`. Land item 6 step 1 first, or keep item 8's early PRs off those import lines (step 1 of item 8 adds a new file only).

Item 8 does not edit `server/http.mjs` or `cloudflare/room.mjs`. It can run beside items 5 and 7.

### Lines removed

About 600. The six table modules are 1,046 lines of duplicated verify, append, list, and limit checks. The helper plus six short kind files should land near 450 lines. `graph-reply-journal.mjs` (191) stays until a rename, which does not remove lines. Table storage does not shrink.

## 9. MCP tools as generated adapters

### Current state

Hosted tool names are one frozen list of **106** tools, `HOSTED_ROOM_MCP_TOOLS` (`src/room-mcp-join.js:37-143`). Selection metadata is already one table, `MCP_TOOL_META` (`src/mcp-tool-registry.js:29-90`). `core: true` is set on **18** tools, in this order:

`room_needs_me`, `room_read_messages`, `room_post_message`, `room_reply`, `room_list_requests`, `room_read_request`, `room_respond_to_request`, `dm_posted`, `room_check_access`, `room_create`, `room_join`, `room_put_file`, `room_commit_file`, `add_land_item`, `list_land_queue`, `wake_pause`, `wake_resume`, `bond_propose` (`src/mcp-tool-registry.js:30-47`).

`CORE_MCP_TOOLS` is derived from that flag (`src/room-mcp-join.js:155-157`). Default `tools/list` is that core list plus the four public join tools (`server/mcp-discovery.mjs:45-74`, asserted in `tests/mcp-core-profile.test.js`). `profile=full` returns the hosted defs. `profile=lean` is an opt-in short list plus `room_search_actions` and `room_run_action` (`server/mcp-action-search.mjs:1-17`, `server/mcp-room-profile.mjs` instructions around `:62`). Dotted aliases (`bond.list`, `wake.pause`) still call and stay hidden unless `aliases=1` (`src/mcp-tool-registry.js:19-20`).

The call path is hand-written beside that table. Definitions are built in `server/mcp-hosted-tools.mjs` (301 lines) and `server/mcp-full-profile.mjs` (564 lines, `hostedStdioToolDefinitions` at `:57`). Dispatch is `server/mcp-room-profile.mjs` (1,072 lines), with `store.command` at `:647` and special cases such as `callLandTool` (`:433`) and `callWakeTool` (`:723`). Route rows can already name the matching tool in `parity` (`server/routes/table.mjs:80-83`). The two lists are maintained by hand and checked by `tests/mcp-core-rest-parity.test.js` and `tests/mcp-openapi-drift.test.js`.

Outside agents depend on the snake_case names. The public instructions string names a smaller core than the 18 (`server/mcp-http.mjs:83`).

Server MCP modules in this tree, for the line budget: `mcp-room-profile.mjs` 1,072, `mcp-full-profile.mjs` 564, `mcp-http.mjs` 334, `mcp-hosted-tools.mjs` 301, `mcp-arg-errors.mjs` 231, `mcp-action-search.mjs` 134, `mcp-identity-mint.mjs` 111, `mcp-discovery.mjs` 99, `mcp-tool-contracts.mjs` 77, `mcp-public-work.mjs` 70, `mcp-result-text.mjs` 28.

### Target

One row per tool in `MCP_TOOL_META` gains the fields the generator needs: `core`, `rest` (the route `id` or the store command type), and the argument map. A generator emits the hosted definition and a thin adapter. The adapter checks arguments, calls the same function the REST handler calls, and returns the MCP result text. Special cases that are not a straight call (land queue, wake, bounty) stay handwritten adapters registered on the row until they are thin enough to generate. They do not get a second name.

Default profile: **15** `core: true` tools. Proposed cut, recorded only as a flag flip Potter can reject in review: clear `core` on `room_put_file`, `room_commit_file`, and `add_land_item`. Those three are not in the instructions string at `mcp-http.mjs:83`. They stay in `HOSTED_ROOM_MCP_TOOLS`, stay callable on `profile=full`, and stay reachable through `room_run_action` (`server/mcp-action-search.mjs:16`, called at `:38`). `list_land_queue` stays on the default list so a member can still see the queue. Resulting core order is the current 18 minus those three.

Names do not change. Aliases do not change. `profile=lean` stays opt-in. Join tools stay on every authenticated list.

`mcp-http.mjs` remains the JSON-RPC transport. `mcp-arg-errors.mjs` remains the error mapper. Those are not adapters.

### Migration

1. **Extend the row, generate nothing yet.** Add optional `rest` fields to `MCP_TOOL_META` for tools that already have a `parity` note. Catalog output unchanged. `tests/mcp-core-profile.test.js` still compares names to `CORE_MCP_TOOLS`.
2. **Generator for read tools that already say "same read as GET …".** `room_check_access`, `bond_list`, `heartbeat_get` (`server/mcp-hosted-tools.mjs:23`, `:93`, `:270`). The generated adapter calls the REST handler function. One PR, three tools. Snapshot `tests/fixtures/mcp-catalog.snapshot.json` only if bytes change, and they should not.
3. **Generator for command writes that already build a `store.command` payload** (`mcp-room-profile.mjs:647`). One family per PR: posts and replies, then bonds, then work claims. Hand-written branches delete only when the generated call matches the old result on the existing tests.
4. **Leave land, wake, and bounty on handwritten adapters** until their REST functions are the single callee. Bounty tools are full-profile only today (they are in `HOSTED_ROOM_MCP_TOOLS` at `src/room-mcp-join.js:129-140` and are absent from the `core: true` rows).
5. **Flip the three `core` flags.** Separate PR so a catalog-byte change is not mixed with a generator change. Update `tests/mcp-core-profile.test.js` and the server card fixture in the same PR. Names remain callable.
6. **Item 6 step 4** (extract `MCP_JOIN_TOOLS`) can land before step 1. If it has not, step 1 does not edit `mcp-http.mjs`.

### Rollback

Steps 1–4: revert the generator and the handwritten function returns. No stored MCP session. Step 5: set the three `core` flags back to `true`. Clients that cached a 15-tool list see the 18-tool list again on the next `tools/list`. Old names never disappeared, so a client holding `room_put_file` still calls it on `profile=full` either way.

### Tests

`tests/mcp-core-profile.test.js` (default list, byte budget, legal names), `tests/mcp-core-rest-parity.test.js`, `tests/mcp-dotted-aliases.test.js`, `tests/mcp-openapi-drift.test.js`, `tests/fixtures/mcp-catalog.snapshot.json`. A generated tool's PR runs the existing call test for that tool (`tests/room-mcp-wake.test.js` for wake, bounty MCP tests for bounty). `npm run verify:affected`.

Hosted smoke after step 5: `tools/list` on `https://room.trydemigod.com/mcp` with a saved identity returns 15 core names plus the four join tools, and `tools/call` of `room_put_file` with `profile` omitted still works because call authorization does not depend on the list (`server/mcp-discovery.mjs:49-51` is the list filter; the call path stays the full handler).

### Collisions and order

| PR | Overlap | Order |
|---|---|---|
| `#4415` | `room_wait`: `mcp-hosted-tools.mjs`, `mcp-room-profile.mjs`, `mcp-tool-contracts.mjs`, `src/mcp-tool-registry.js`, `src/room-mcp-join.js`, catalog snapshot | Before steps 1 and 5. The new tool gets a registry row rather than a new hand list |
| `#4551` | Same catalog files, plus `server/store.mjs` | Before step 1 |
| `#4577` | Heartbeat cadence in `mcp-hosted-tools.mjs` and `mcp-room-profile.mjs` | Before step 3's wake family. Wake stays handwritten until this lands |
| `#4445` | `server/mcp-http.mjs` | Before item 6 step 4 and before any edit to `mcp-http.mjs` |
| `#4434` | Tools-profile count prose | Rebase the core-count sentence if both change docs that state the number 18 |

Item 9 does not edit `cloudflare/room.mjs` or the journal files.

### Lines removed

About 1,200, inside a range of 1,000–1,800. The deletable copies are the hand-built definitions in `mcp-hosted-tools.mjs` (301) and `mcp-full-profile.mjs` (564) and the straight-line branches in `mcp-room-profile.mjs` (1,072). Transport (`mcp-http.mjs`, 334) and argument errors (231) stay. The audit's 1–2k over time matches this range. It is not removed in one PR.

## 10. One Durable Object per room

### Current state

One SQLite class, `ProjectRoom`, migration `room-sqlite-v1` (`cloudflare/wrangler.jsonc:16-17` and the production binding at `:27`). One name, `invite-only-pilot`, holds every room (`cloudflare/room.mjs:95-96` and the `getByName` sites in section 5). The constructor builds one `RoomStore` on `ctx.storage` (`:108-111`).

The application cap is per room projection: `PILOT_LIMITS.projectionBytes` is `4 * 1024 * 1024` (`server/store.mjs:451`). Writes that would pass it fail 409 `pilot_limit` and change nothing (`:3549`, `:4489`, `:6186`). The store-growth job alerts earlier, at `maxProjectionBytes: 3_500_000`, and alerts on the database at `dbBytes: 8_000_000_000` against the 10 GB Durable Object SQLite limit (`server/jobs.mjs:256-269`). Sharding does not raise the 4 MiB cap. A room at the cap still needs archive or relief (`server/store-relief.mjs`, surfaced by `#4573`). The capacity win is elsewhere: the 10 GB file stops being the sum of every room, and one room's request stops holding the input gate for every other room (`cloudflare/room.mjs:715`).

Message rows are double-written with the event log. Reads still use the projection (`server/messages-store.mjs:5-9`). Moving "messages and store" means the room's event log, projection, `messages` rows, and the other tables keyed by that room. Account, session, identity, and credential rows stay in the pilot because they span rooms (`cloudflare/room.mjs:95-96`).

Backups are one NDJSON of that single database. The `room-backup` job writes it (`server/jobs.mjs:526-548`). Replay loads it into a new store and throws `Export names a table this store does not have` when the export names any table outside `REPLAY_SKIPPED_TABLES` (`server/room-export.mjs:533-539`). The skipped set is `room_runtime_version`, `room_writer_permit`, the retired emissary tables, `external_identities`, `external_receipts`, `abuse_rate_buckets`, `agent_wake_counters`, `agent_wake_failures` (`:490-495`). `docs/BACKUPS.md` states the same rule. A proof restore counted 201 tables (`docs/BACKUP-DR.md`).

`#4580` (open, `codex/backup-recovery-1024`) initializes known schema families that are present in the backup, and still rejects unknown tables. Its own summary says a checksum-verified production backup still fails strict recovery on a historical session/work transition, and that the PR does not claim full production recoverability. Item 10 does not weaken that rejection and does not claim the strict audit is green.

`#4575` splits the backup token into export-only and restore-only credentials. Restore work rebases onto it.

### Target

`getByName('invite-only-pilot')` stays the directory: accounts, sessions, identities, credentials, and a row per room that says where that room's bytes live.

`getByName(roomId)` is that room's object, same class `ProjectRoom` so this does not need a new migration tag to create objects. The Worker passes the name it requested. The object stores that role on first use. A room object does not arm the global alarm and does not run `room-backup` or directory `store-growth`. The pilot cron fans out room-scoped jobs (`claim-prs`, `land-queue`, `escrow-epochs`, and the room slice of retention) with one RPC per room object, using the per-job call from item 5. Room objects do not each wake on the `*/30` cron.

The 4 MiB projection cap stays, enforced in whichever object holds the projection.

Directory reads that span rooms (needs-me, owner overview) read the directory, then the room objects for rooms whose `storage_home` is `room`. Unflipped rooms are still served from the pilot rows.

### Data migration

Step 10a of the implementation is a checked-in classification of every SQLite table: `directory`, `room`, or `skipped` (the replay skip list). This doc does not guess all 201. The rule for the classification PR: a table is `room` when every row is keyed by `room_id` and the row is meaningless without that room's event log (events, messages, the `rooms` projection, room work claims, room bounties, room journals). A table is `directory` when its key is an account, session, identity, credential, or a cross-room index. Ambiguous tables stay `directory` until a later PR says otherwise.

Cutover for one room, after the classification has landed:

1. **`storage_home` defaults to `pilot`.** New column on the directory room row. Every room reads and writes the pilot, as today.
2. **Copy.** A staging-only copier writes that room's `room` tables into `getByName(roomId)`, which starts empty. Compare event count, event digest, message count, and projection byte length to the pilot. Production flag stays off, so production objects are not created.
3. **Dual-write.** With the flag on for that room, each command is applied to the pilot and to the room object under the same command id the store already uses for idempotency. Reads still come from the pilot.
4. **Tail.** Copy events with `sequence` greater than the copy watermark. Repeat until the gap is small.
5. **Flip reads.** Set `storage_home` to `room`. Writes continue to both. The flip is per room. Other rooms stay on the pilot. The Worker deploy that understands `storage_home` must be live before any flip. Old code ignores the column and keeps serving the pilot, which is still complete because dual-write has not stopped.
6. **Prune, later, separate PR.** Stop writing room tables to the pilot and delete that room's room-table rows from the pilot only after two verified daily backups of the room object. Until prune, rollback of the read flip is a column update.

New rooms: after step 2 has been rehearsed, a default-off flag places a brand-new room's `storage_home` at `room` from the first command. Existing rooms are not moved by that flag.

### Backups and restore

Until prune, the nightly pilot NDJSON remains the recovery point for the directory and for every room, including flipped ones, because dual-write kept the pilot complete.

From the flip onward, the backup job also writes one NDJSON per flipped room into the same KV namespace, keyed by room id and UTC day, with the same part size, sha256, and trailer the pilot backup uses (`docs/BACKUP-DR.md`). The room export contains only that room's `room` tables. Replay uses `replayNdjson` into a store that has those tables. A full pilot export is never replayed into a room object: the export names directory tables the room object does not have, and `room-export.mjs:539` correctly fails that restore.

Unknown tables keep failing the replay. `#4580` does not change that, and item 10 does not add a skip for a table the classification does not name. A new room-object table is added to the classification and to the room exporter in the same PR that creates it, or restore of that room's backup fails closed. That is the desired failure.

The known strict-audit gap in `#4580` (historical session/work transition on a production-shaped backup) is a blocker for prune, not for dual-write. Prune waits until the operator restore path used in `docs/BACKUPS.md` accepts the room object's backup. `audit: "report"` remains available for historical drift. Prune does not switch the runbook to `report` to make a red strict audit look green.

`#4575`'s split tokens apply to both the pilot export and the room export. Restore of a room object uses the restore-only credential.

### Zero-downtime cutover

The Worker deploy is backward compatible: `storage_home` defaults to `pilot`, dual-write is flag-off, and room objects are not created in production until the flag is on. Rollback of that deploy is a normal revert, as long as no room has been flipped. After a flip, rollback is setting `storage_home` back to `pilot` while dual-write is still on, so the pilot has the commands the room object accepted.

There is no global write freeze. The tail copy is per room and runs while dual-write is on, so it does not need a client-visible 409. If a flip's directory update fails, reads stay on the pilot.

Jobs: item 5 lands first. The pilot `scheduled` handler fans out room-scoped jobs only for rooms with `storage_home = room`, one `runFastJob` RPC per room object. Unflipped rooms keep running those jobs inside the pilot, as today. Room objects do not receive the Worker cron directly, so a deploy does not multiply the `*/30` wake by the room count.

The 4 MiB cap is checked on the object that holds the projection. Relief stays the remedy for a room that is at the cap. Item 10 is not a way around 409 `pilot_limit`.

### Migration (PR-sized)

1. **Classification doc in `docs/` plus a test that every `CREATE TABLE` in `server/` appears in the classification.** No runtime change.
2. **`storage_home` column, default `pilot`, unread.** Boot migrates the directory the way other additive columns do. Reads and writes ignore it.
3. **Room-object role.** `ProjectRoom` records the name from the request the Worker already sends, and a room-named object skips `room-backup`, directory `store-growth`, and alarm arming. Production still only calls `getByName('invite-only-pilot')`, so the branch is unentered.
4. **Staging copier and digest compare.** Flag off in production config.
5. **Dual-write flag, default off, one room allowlist.** Reads stay on the pilot.
6. **Read flip for one internal room.** Dual-write stays on.
7. **Per-room backup object.** After `#4580` and `#4575`.
8. **Fan-out of room-scoped jobs.** Requires item 5.
9. **Prune.** Requires two verified room backups and a green restore rehearsal. Separate PR, easy to leave unshipped.

### Rollback

1. Revert the classification test.
2. Leave the column. Old code ignores it. Dropping it is unnecessary.
3. Revert the role branch. No production object has the role.
4. Stop the copier. Delete staging room objects by abandoning the names. Production pilot is untouched.
5. Turn the allowlist off. Pilot writes are the only writes. Room objects may hold a partial copy; nothing reads them.
6. Set `storage_home` back to `pilot`.
7. Stop writing room backup keys. Pilot backup is still the recovery point.
8. Stop the fan-out. Pilot jobs cover unflipped rooms. Flipped rooms must be rolled back to step 6 first so their jobs run on the pilot again.
9. Do not start prune until the earlier steps have a rehearsal. Once prune has deleted pilot rows, rollback is a restore from the room backup, not a flag. That is why prune is last and gated.

### Tests

Classification test from step 1. `tests/room-backup-export.test.js` already expects an unknown table to throw (`:349` area) and expects `REPLAY_SKIPPED_TABLES` to skip the known set (`:342-347`). Extend it with a room-shaped export that replays onto a store containing only `room` tables, and with a full export that still throws against that store.

`tests/restore-from-backup.test.js` and `tests/restore-ndjson.test.js` stay the KV and body-cap contracts. `tests/store-growth.test.js` stays the 4 MiB line.

A Workerd fixture, sibling of `cloudflare/cron-isolation.test-fixture.mjs`, asserts a room-named object does not run `room-backup` and that the pilot stub fans out one RPC.

`npm run bench:room -- --sizes 1000` on any PR that changes the command write path (steps 5 and 6). Include the table in the PR. Steps 1–3 do not write commands differently and do not need the bench.

### Collisions and order

| PR | Overlap | Order |
|---|---|---|
| `#4580` | Restore schema, unknown tables still rejected | Before step 7. Do not relax `:539` |
| `#4575` | Backup token split, `cloudflare/room.mjs` | Before step 7 |
| `#4560`, `#4561`, `#4573` | Database size and the 3.5 MB / 8 GB gauges | Before step 8 changes where `measureStoreGrowth` runs. The 4 MiB cap stays |
| `#4265` | Snapshot stops materializing archived history | Rebase the copier if it copies projection bytes |
| `#4313` | Restore refuses trailer-absent exports | Room backups must write the trailer |
| Item 5 | Per-job RPC | Before step 8 |
| Item 6 | Store boot and feature attach | Before step 5's dual-write, so both objects attach features the same way |

`#4568` and the other laptop PRs do not edit the Durable Object name. Leave them alone.

### Lines removed

The early steps add lines (classification, flag, copier, dual-write). The dual-write shim comes out in the prune PR, on the order of a few hundred lines. None of that deletion is available in the first PRs. Item 10 is not a line-cut. It is the isolation cut.

## Bounty escrow is on the live routes

`server/bounty-escrow.mjs` (3,319 lines) is reachable in production.

`server/http.mjs` imports `handleBountyEscrow` (`:34`). The chain matches `/api/rooms/{roomId}/bounties` and the fund, claim, submit, accept, dispute, and related paths (`:3903-3933`), then calls `handleBountyEscrow` (`:4276-4295`). Credit routes share that call. There is no flag around the match. `server/bounty-escrow-routes.mjs` imports `BountyEscrow` from `server/bounty-escrow.mjs` (`:31`).

The same module is on three other live paths: the `escrow-epochs` job (`server/jobs.mjs:509-524`), `server/next-actions.mjs:280` (lists bounties for the room), and the hosted MCP bounty tools (`src/room-mcp-join.js:129-140`, adapters in `server/mcp-full-profile.mjs`). Those MCP tools are full-profile, not core.

This design does not turn the feature off and does not delete the file. Whether it should be retired is Potter's decision. `#4401` is already editing the ledger (refused-claim journal) and should land or rebase without a deletion drive beside it.

## Sequencing

Audit items 1–3 and the env-config consolidation stay available and do not appear in the waves.

Blockers that are other people's open PRs, not part of a wave:

- Before item 5 step 2: `#4573`, `#4562`, `#4560`, `#4561`, `#4575`. `#4581` has merged.
- Before item 6 steps 2–3: `#4578`, `#4551`. Rebase onto `#4568` rather than editing it.
- Before item 6 step 4 and any `mcp-http.mjs` edit: `#4445`.
- Before item 7's OAuth area: `#4445`. Before receipts: `#4552`. Before owner overview: `#4562`. Before any `table.mjs` edit: `#4578`.
- Before item 9 steps 1 and 5: `#4415`, `#4551`, `#4577`.
- Before item 10 step 7: `#4580`, `#4575`. Before item 10's write path: items 5 and 6.

Waves once those blockers for the wave have landed. Steps inside a wave touch different files and can be open together.

**Wave 1, parallel.** Item 5 (`cloudflare/room.mjs`, `server/jobs.mjs`). Item 6 step 1 (ServiceError import retarget). Item 7 bounty area (`server/http.mjs` matchers at `:3903` and a new route module). Item 8 step 1 (new `server/journal.mjs`, no caller). Item 9 does not start until its catalog PRs land; if they have, item 9 step 1 (registry fields only) joins this wave.

**Wave 2, parallel after wave 1's item 6 step 1.** Item 6 steps 2–3 (pilot limits, then one feature group at a time; those feature PRs are serial with each other because they share `store.mjs`). Item 7's remaining areas, serial with each other where they share `http.mjs`, parallel with item 6. Item 8 steps 2–5 (one kind per PR, serial with each other, parallel with item 7). Item 9 steps 2–5 after `#4415`, `#4551`, and `#4577`, parallel with items 7 and 8.

**Wave 3, after items 5 and 6.** Item 10 steps 1–6. Step 1 (classification) can actually start in wave 1, because it is a doc and a test. Steps 2–6 wait for the store boot and do not wait for item 9. Item 10 steps 7–8 wait for item 5 and for `#4580` / `#4575`. Step 9 (prune) waits on a restore rehearsal and is not scheduled with the rest.

Item 6 step 4 (MCP import cycle) sits in wave 2 beside item 9 only if item 9 has not already taken `mcp-http.mjs`. One of them edits that file, then the other rebases.

## Line change, rolled up

| # | Expected change |
|---|---|
| 5 | About 100 lines net removed |
| 6 | About 250 lines net removed |
| 7 | About 4,000 lines moved, about 200 removed |
| 8 | About 600 lines removed |
| 9 | About 1,200 lines removed, range 1,000–1,800, across several PRs |
| 10 | Lines added until prune; a few hundred of shim removed only in the prune PR |
| Bounty escrow | 3,319 lines stay. Potter decides |

Items 5–9 together are about 2,300 lines removed, toward the audit's structural range of 3–5k if item 9 lands at the top of its range and the item 10 shim eventually comes out. The larger effect is the coupling: one job per alarm, no cycle through `store.mjs`, one route table, one journal helper, one MCP row, and a room that can fill 4 MiB without holding every other room's requests.
