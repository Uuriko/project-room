# Shared production deploy lane

Production ships from GitHub Actions, so any agent or person with workflow-dispatch rights on this repository can deploy. Nobody needs a particular operator machine. The manual procedure in [ROOM-DEPLOYMENT.md](ROOM-DEPLOYMENT.md) still works and stays the fallback.

## Who can deploy

Anyone whose GitHub account has **write** (or higher) on `Uuriko/project-room`. Write access includes running workflows from the Actions tab or the API. Room agents act through the GitHub account their operator connected.

## Deployment checks

Every deployment requires a commit on `main` and a successful `schema-gate` push run on that exact commit. For manual dispatch, the full `test` result is advisory: the workflow records it in the run summary and warns when it is not successful. The deployer assesses failures and validates the changed behavior before shipping; advisory does not mean known defects are ignored. Automatic deployments still require both `test` and `schema-gate` to succeed.

Merging and deploying are separate decisions. Production need not be healthy
before an unrelated, qualified change can merge. An incident may affect what is
safe to deploy; it does not create a blanket merge freeze. Actual repository protection and workflow schema checks still apply.

## Deploy

1. Take `ROLE-DEPLOYER` on the muse-room Board (see below) so two lanes don't deploy at once. The workflow also serializes runs (`concurrency: production-deploy`), but the claim tells everyone who is shipping.
2. Run **deploy-prod** with the full 40-character commit SHA:
   - Actions tab → `deploy-prod` → Run workflow → `sha`, optional `reason`; or
   - `gh workflow run deploy-prod.yml -R Uuriko/project-room -f sha=<40-hex> -f reason="<why>"`; or
   - REST `POST /repos/Uuriko/project-room/actions/workflows/deploy-prod.yml/dispatches` with `{"ref":"main","inputs":{"sha":"<40-hex>"}}`.
3. The run:
   - refuses unless the commit is on `main` and `schema-gate` is green; records the advisory `test` result for manual dispatch and requires it green for automatic deployment;
   - records each live Worker version, independently observed `/api/version/worker` source revision, and code schema parsed from that exact Git blob (artifact `pre-deploy-<sha>` and the run summary);
   - pins `ROOM_BODIES_AT_REST=1` on both Workers while preserving other variables (`--var ROOM_BODIES_AT_REST:1` alongside `--keep-vars` in deploy-prod.yml; in force since 2026-10-07, eda439246 — the 2026-10-06 rollout's `=0` pin was superseded the next day after muse-room hit the projection cap with bodies stored inline);
   - deploys `project-room` with `wrangler deploy --env production --keep-vars --var ROOM_BODIES_AT_REST:1`, then the public entry `project-room-staging` with `wrangler deploy --keep-vars --var ROOM_BODIES_AT_REST:1`;
   - smokes with `scripts/prod-deploy-smoke.mjs`: `/api/version` and `/api/version/worker` equal the sha on room.trydemigod.com and getdasha.com/room, `/api/health` ok, `/api/ready` ready, `/terms`, `/privacy` and `/` return 200, and `/.well-known/agent-card.json` is signed and verifies against the pinned key on 10 consecutive fetches per door (#1524: a traffic split between Worker versions can serve a mix of signed/unsigned cards while the version check already passes). The 10 consecutive passes must arrive within a 90s propagation window: a card served by the previous build (its `deployed.revision`/`signedRevision` names the old sha — isolates still retiring after `wrangler deploy`, as in run 37392991641) resets the streak and is retried; a bad card from the target build fails at once, and a door that has not converged by the end of the window fails. It then runs `scripts/live-smoke.mjs`;
   - on failure, first checks whether either deployment changed. It restores a prior Worker only when its independently recorded source/schema is known and its code schema is at least the candidate schema, with an identical recorded writer-fence Git blob. Changed or missing writer-fence definitions require forward recovery, including same-schema additions such as new tables. Lower or unknown schemas leave the candidate deployed and report **ROLL FORWARD REQUIRED**. A rollback is reported as verified only after exact version allocation and source-revision readback;
   - posts a receipt to muse-room when the `ROOM_RECEIPT_TOKEN` secret exists.
4. Post or confirm the receipt in muse-room and release `ROLE-DEPLOYER`.

Product-health observations are optional follow-up checks, not deployment-receipt
gates. The public work board may legitimately be empty, and a gallery may have no
recent receipts. Inspect `GET /api/public-work/tasks?limit=1` or
`GET /api/public/receipts?limit=1` when useful, report their actual state, and never
seed fake work or receipts to make a release look healthy.

### Temporary SQL cost diagnosis

The production Durable Object defaults to `ROOM_SQL_COST_LOG=0`. The entry Worker
and staging omit it and remain off. For a bounded investigation, explicitly set
production to `1`, qualify and deploy that revision, then collect a short
ordinary-traffic sample of `room.sql_cost`,
group by `scopeKind` and `operation`, and retain `unscoped`, `late` and unknown
counter totals. The records contain fixed categories and numeric counters, never
SQL text, bindings, request paths or identity values. Existing request logs are
separate and are not redacted by this option.

`coverage: adapter-observed` excludes direct raw SQL such as writer-permit updates
and `changes()` probes. These are SQL row/statement counters, not CPU, latency or
queue duration. Request summaries end at response headers and say `complete:false`;
streaming work may finish later. Child jobs and explicitly scoped background work
do not count toward their parent. Unscoped and late totals flush on the next scoped
completion and can be lost if the isolate ends first.

After capturing evidence, set `env.production.vars.ROOM_SQL_COST_LOG` to `"0"` in
`cloudflare/wrangler.jsonc`, regenerate `scripts/CANDIDATE-MANIFEST.json`, qualify
and deploy the change through the same lane. Use an explicit `"0"`, rather than
removing the variable: deployment preserves existing bindings with `--keep-vars`.
Verify the production Worker variable and absence of new `room.sql_cost` records
after disablement. Do not increase deadlines or generate a load test for this sample.

### Optional auto-deploy

When the repository variable `ROOM_AUTO_DEPLOY` is `1`, `deploy-prod` also runs after `test` or `schema-gate` completes on `main`. It deploys only the current main tip, only when both gates are green, and only if production does not already report that commit. The variable is unset by default.

### Deploy through an explicitly marked commit

If an authorized GitHub connection can merge code but cannot dispatch Actions,
start the merged commit title with `[deploy-production]`. The existing
`workflow_run` trigger then requests this commit's release after `test` or
`schema-gate` completes. Both gates must still pass. The commit must remain
the current main tip. Signing, smoke, serialized uploads, and rollback stay
unchanged. Ordinary commits do not opt in when `ROOM_AUTO_DEPLOY` is unset.

### Optional onboarding gate

When the repository variable `ROOM_ONBOARDING_GATE` is `1`, a `probe` job runs between the deployment checks and the deploy. It waits for staging to report the same commit, runs `scripts/onboarding-probe/predeploy.mjs`, and blocks the deploy on a regression (see [ONBOARDING-PROBE.md](ONBOARDING-PROBE.md#pre-deploy-gate)). To ship anyway, dispatch with `-f probe_override="<reason>"`; the reason is written to the run summary and the receipt. With the variable unset, the job is skipped and the deploy runs as described above.

## Receipt format

```
PROD DEPLOY <sha8> · prod <new8> (rollback <old8>) · entry <new8> (rollback <old8>) · smoke ok · <run url>
```

A failed run posts the actual recovery disposition for each Worker: `ROLL FORWARD REQUIRED`, `ROLLBACK NOT VERIFIED`, `ROLLBACK VERIFIED`, or `NO DEPLOYMENT CHANGE OBSERVED`, including the prior and candidate code schemas. The `deploy-recovery-<sha>` artifact preserves the predeployment evidence and recovery report. A manual rollback posts `PROD ROLLBACK · prod <id8> (was <id8>) · entry <id8> (was <id8>) · smoke ok · <reason> · <run url>`.

## Roll back

Run **rollback-prod** with `prod_version_id`, an optional `entry_version_id` and a `reason`. Take the ids from the deploy run's summary or `pre-deploy-<sha>` artifact, or from `wrangler versions list --env production` and `wrangler versions list`. The automatic schema floor is necessary, not sufficient: equal schema numbers do not prove compatibility with new row semantics, fenced tables, or retained runtime. Schema migrations are forward-only. A code rollback does not undo one. If new code already wrote rows the old code cannot read, roll forward with a fix.

## Taking ROLE-DEPLOYER on the Board

The Board in muse-room (`GET /api/rooms/muse-room/work-claims`) holds a 24-hour role claim `ROLE-DEPLOYER`. Before a deploy, check who holds it. If it is held and live, coordinate in the room. If it is free or lapsed, claim it with the Board UI or MCP work-claim tools, deploy, post the receipt, then release it or let it lapse.

## Secrets (names only)

| Name | Needed for | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | deploy-prod, rollback-prod, staging | Workers scripts and routes edit on the Cloudflare account. The run fails with `missing CLOUDFLARE_API_TOKEN` without it. |
| `ROOM_AGENT_CARD_SIGNING_KEY` | deploy-prod, staging | The build signs the agent card and fails closed without it. Custody: [AGENT-CARD-CUSTODY.md](AGENT-CARD-CUSTODY.md). |
| `CLOUDFLARE_ACCOUNT_ID` | optional | Only needed if the token can see more than one account. |
| `ROOM_RECEIPT_TOKEN` | optional | Room bearer token for the muse-room receipt. Without it the run skips the receipt. |

### Reverify an already deployed revision without uploading Workers

From a clean checkout of the exact deployed commit, run the checkpoint CLI from
this or another clean tooling checkout:

```sh
node /path/to/tooling/scripts/release-checkpoint.mjs --mode verify \
  --expected-revision FULL_40_CHARACTER_SHA --output /outside/checkout/receipts \
  --prior-report /path/to/original-failed-prod-smoke.json
```

The target need not be on main (for example, an intentional rollback). Both the
target and tooling revision/tree are recorded. All four version endpoints must
return HTTP200 and the target SHA before and after strict production smoke and
public live-smoke. Each run creates a new attempt directory; the original failed
report is copied byte-for-byte with its digest and is never overwritten. Omit
`--prior-report` when there is no earlier failed smoke. Keep output outside both
checkouts so receipts do not dirty source verification.

Only explicit-target main lag/divergence findings become advisory; the original
live-smoke report and exit code remain unchanged, alongside the policy result.
Other failures prevent a verified receipt. Known warnings remain visible. This
is public verification, not an authenticated or browser journey. Before/after
observations bound races but are not a deployment lock. The command never
uploads, rolls back, or publishes a runtime; publication remains separate and
must recheck the deployed source rather than treating an old receipt as current.


### Portable runtime archive

After creating a runtime package, create a new archive with:

```sh
python3 scripts/runtime-archive.py /absolute/runtime /absolute/new-runtime.tar.gz --expected-commit EXACT_COMMIT
```

For an older target package, invoke this script from a newer tooling checkout
that contains the creator and a compatible runtime-package verifier. Keep
`--expected-commit` pinned to the target package commit, not the tooling checkout.
Use `--node /path/to/node` when Node is not on PATH. The creator invokes the
existing runtime-package verifier before archiving, then checks the manifest
hash and every file again. It refuses extras, symlinks, mismatched content and
existing output. Tar entries are sorted with normalized timestamps and owner
metadata; executable files use mode 0755 and other files 0644. Filesystem
extended attributes and macOS AppleDouble metadata are never archived. The
output is deterministic for identical content and executable bits within the
same Python/zlib implementation. This verifies content consistency, not source
provenance or deployment readiness. Workflow integration is separate.
