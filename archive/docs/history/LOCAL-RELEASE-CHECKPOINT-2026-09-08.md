# Durable local candidate — September 8, 2026

**Later correction:** fallback135d824 failed browser draft/privacy qualification.
Use the [draft-compatible fallback4d22189 checkpoint](FALLBACK-DRAFT-CHECKPOINT-2026-09-08.md).
The original packages/evidence below are retained historical records, not the
current fallback selection. Candidate9745978 is unchanged.

## Preserved outcome

Runtime candidate: `9745978c784b71ac90487d37b4e5d7b26fa45ef4` on
`codex/unified-local-20260907`. This commits the previously tested quiet interface,
contribution/review flow, human request composer and recovery, observer v3,
manual native-host harness/evidence notes, and current recovery regression.
No native model was run in this checkpoint. Prior native acceptance stays partial.

Two real, distinct packages are retained outside the checkout, under
`../project-room-runtime-packages-20260908/`:

- `candidate-9745978`:65 runtime files,19 assets, schema/writer12.
  Manifest SHA256:`8ed56c875656314cba9fc9c824caa4819a35d9a5041682b4fdc48f2c5635b16d`.
- `fallback-135d824`:64 runtime files,19 assets, schema/writer12.
  Exact source:`135d82489c62071b3f4eb00710ae4d9787374158`.
  Manifest SHA256:`7e310ba463673ad84e968c83a5cab5b31af733cb9fc26d38ac1044c08f700eff`.

All65 current runtime source files were independently compared to the retained
candidate hashes. Both packages verified again after the actual package-switch
drill. They contain no test wrappers, native runner, local database or credentials.
Do not rewrite these directories when source changes; preserve a new exact package.

## Qualification

- 536 core/API/package checks passed after the real commit, including cold packaged
 Node startup and immutable-package validation.
- 168 browser checks passed, including mobile, keyboard, enlarged text, request
 answers and recovery, contribution journeys and exact-result review.
- 13 local Workers runtime checks passed. The schema12 switch used the **retained**
 candidate and fallback, not a synthetic commit. The historical schema8 test remains.
- One local Workers browser journey passed, including two browsers, SSE and restart.
 Local self-signed TLS diagnostics still appear; no production TLS claim is made.
- An explicitly invalid retained-package configuration failed instead of silently
 falling back to a synthetic success. This is a separate manual negative check.

`cloudflare/recovery-switch.check.mjs` accepts paired absolute
`ROOM_RECOVERY_CANDIDATE_PACKAGE` and `ROOM_RECOVERY_FALLBACK_PACKAGE` paths.
For schema12 it verifies those artifacts, uses their application runtimes, checks
the fixed fallback source, refuses equal commits, then re-verifies them after use.
With neither variable, ordinary regression still packages working-source fixtures.
Setting just one variable or providing invalid artifacts must fail qualification.
The temporary fixture is deleted; explicitly supplied packages are never deleted.

The retained run preserved20 application tables through candidate → pause →
fallback → candidate. Data, request/response receipts, exact native result bytes,
invitations, reminders and identities survived; new work and answered requests on
fallback retried identically on candidate. V3 inbox history/notices survived its
unsupported-fallback refusal. It does **not** establish browser draft compatibility
with the older UI, provider recovery, or authority freshness after restoring old data.

Evidence is retained separately in `../project-room-runtime-packages-20260908/evidence-9745978/`:
three full regression logs, three inspected screenshots and a hash/size manifest.
The screenshots show desktop sign-in, desktop return and touch exact-result review.
The one Workers browser result is recorded in tool output; it is not one of the
three saved logs. All user journeys are simulations, not human preference research.

## Remaining release gates and primary-source check

Browser fallback remains a separate local qualification gap: exercise candidate
drafts, fallback reload/sign-out, and return to candidate in the same browser.
Check both ordinary and request drafts, unknown retries, identity changes and
private-state clearing. Passing a server data audit does not prove this behavior.

Cloudflare distinguishes code/configuration versions from storage state; a Worker
rollback is not a database restore. This reinforces keeping the two drills separate.
[Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/).

SQLite Durable Objects support bookmark-based recovery within30 days. Restore is
applied on restart, and the restore call returns an undo bookmark. Our proposed
hosted drill must retain both bookmarks outside the restored object and verify
restore, reconnect and undo without reopening user traffic prematurely.
[Storage/PITR documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api).

Provider rollback eligibility also depends on resource bindings and Durable Object
class lifecycle changes. The local application schema12 check is not proof that
the provider will accept a particular deployment rollback.
[Rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#limits).

Sources checked September8. These are deployment-planning findings, not evidence
of any hosted action. Continue the existing recovery runbook with schema12 artifacts;
do not use its historical schema8 packages for current data.

## Now / next / later

- **Now:** retain this clean local candidate; preserve preview64985. No push or
  deployment has happened. Native AI usage and hosted recovery need current approval.
- **Next, authorized local work:** qualify browser draft/privacy behavior across
  the retained fallback switch; specify and test current-authority reconciliation
  after a historical restore, without exposing a public restore endpoint. Review
  the observed UUID clutter in guest attribution, preserving accessible identity
  details and disambiguation. Explore eligible-work suggestions only as explicit
  discovery, never automatic acceptance or execution.
- **Next, gated:** independent native-agent verification after usage approval;
  isolated hosted restore/undo and provider binding qualification after approval.
- **Later:** optional reward/provider integrations and measured growth experiments.
  Keep free manual/BYO-agent flows useful; no fabricated retention or human findings.

The overall goal remains incomplete. There are no new services, payments,
recurring jobs or cross-product edits. Preview/runtime processes were not restarted.
