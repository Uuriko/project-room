# Selected-task context: local checkpoint

The active long-running goal advances; it is not complete. This local candidate
adds one authenticated task read, not a runner, browser control or parallel work
system. It is not pushed or deployed.

## What is built

`GET /api/rooms/:roomId/work-context?workItemId=ID` and
`RoomAgentClient.workContext(id, options)` return one coherent selected task:
current roles, scope claim, blocker, exact receipt/review/decision, next actor and
permission-aware suggested Room actions. One read transaction and evaluation
clock provide its commit/revision boundary. Source inclusion is explicit and exact.
Other work/messages, histories, private reminders and read markers are omitted.

The existing inbox gains `work WORK_ID [--include-source]`; the tested write guide
uses selected reads instead of two room-wide downloads and manual source joins.
Inputs and returned identity/source relationships are checked; reads can be
cancelled and never retry writes or follow evidence. Portable packets remain a
separate, narrower opt-in export. Authenticated membership remains room-wide.

A reviewer found and root fixed an older encoded-colon Room-ID round-trip bug in
shared HTTP routing. Components are decoded once and checked by the existing ID
validator. No domain permissions, storage schema or dependency changed.

## Evidence

- **361 core/API, 76 browser, seven local Cloudflare checks pass.**
- Fifteen exact public assets and a 201,966-byte production bundle checked locally.
- Current desktop/narrow-large-text screenshots inspected; browser UI unchanged.
- Two fresh actual agents resumed blocked fictional write work using only selected
  context. Original artifact independently retrieved, hashed and genuinely reviewed.
  Final sequence 20/revision 12; scope released, all three read markers 0, human decision
  still null. Prior synthetic history is explicitly excluded from actual-agent counts.
- In that fixture, one selected read returned 5,109 bytes versus 26,236 bytes across
  the prior guide's two room-wide reads. No token/retention/performance lift inferred.
- Fixture listeners stopped and plaintext role configurations/TLS private key removed.
  Original non-sensitive artifact retained unchanged in the evidence folder.

See [plan and primary sources](WORK-CONTEXT-PLAN-2026-09-07.md),
[interface guide](WORK-CONTEXT.md), and [detailed evidence](evidence/work-context-2026-09-07.md).
Root was sole source/doc/test editor; three read-only reviewers and two fresh
participant agents supplied independent work. No live or hosted-CI claim is made.

## Now / next / later

Now: preserve this local checkpoint and the earlier reminder, watcher, calm-return
and invitation improvements. Keep the overall goal active.

Next: inspect and plan the **v8-compatible release/fallback/recovery package**.
Multiple useful local slices now sit above recorded live v7. Prove a disposable
backup/recovery and compatible fallback rather than accumulating more release
uncertainty. This is local preparation, not authority to migrate, deploy or call
provider administration. Old v7 code cannot roll back migrated v8 data.

Then: research one reusable-outcome/template loop that helps a second collaboration,
with an exact preview, deliberate inclusion, no copied credentials/permissions or
automatic public posting. Keep advanced controls contextual. Add more interfaces
only when they reuse the tested task/authority model and solve a demonstrated gap.

Deferred gates: verified identity recovery, hosted AI/runtime/MCP compatibility,
real bounties/payments/Stripe/stablecoins, Dasha/provider integration, human trials
and actual retention/referral measurement. Do not imply these are finished.

Recorded live remains app fb90a70 / Worker 901be347 / Room v7, not reverified here.
No push/deploy/live migration/DNS/account/provider/Dasha/Desk/payment/outreach/
paid-compute/recurring-automation changes occurred. Local schema v8 came from the
earlier reminder slice; this task view itself requires no migration.
