# Project Room CI/CD pipeline (guild-17 reference)

_Date: 2026-10-08 · verified against `origin/main` @ b53c52af1 · branch protection read live from the GitHub API._

## The pipeline in one picture

```
PR opened/updated
  ├─ test.yml ──► checks: test · contract · lint · browser · cloudflare   (REQUIRED)
  ├─ schema-gate.yml ──► check: schema-gate                              (advisory, NOT required)
  ├─ review-mechanical.yml (fast signals → job summary; full report on test completion)
  ├─ pr-diff-size.yml · qa2-agent-eval.yml · qa3-gates.yml · zero-bug-* · machine · relay …
  └─ secret scan (inside test.yml, merge-blocking)
        │
        ▼  merge (one-at-a-time slot; reviews ADVISORY since #1786;
           conversation resolution required; admins enforced)
        │
  push to main
  ├─ test.yml / schema-gate.yml / mime-fuzz / machine / relay re-run on the merged tree
  ├─ staging.yml ──► deploys project-room-stage (workers.dev)   [carries deploy secrets]
  ├─ mcp-registry-publish.yml ──► publishes server.json (only if it changed)
  └─ trace-entry.yml ──► bot PR appends docs/ROOM-TRACES.jsonl ──► merges through the gate
        │
  deploy-prod.yml (workflow_dispatch, or auto on [deploy-production] title / ROOM_AUTO_DEPLOY=1)
  ├─ gate: SHA must be on main + test & schema-gate push runs green on that SHA
  ├─ (optional) onboarding probe against staging
  ├─ wrangler deploy --env production → project-room (room.trydemigod.com)
  ├─ smoke checks → receipt to muse-room
  └─ rollback-prod.yml on failure (recover only to prior code ≥ known schema floor)
```

## Workflow inventory (31 files)

| Workflow | Triggers | What it does | Secrets |
|---|---|---|---|
| test.yml | PR, push main, merge_group | unit shards (3), browser shards (6), contract, lint, cloudflare jobs; secret scan | GH_TOKEN (read) |
| schema-gate.yml | PR, push main | shard-migration convergence vs legacy fixtures | none |
| deploy-prod.yml | dispatch, workflow_run(test/schema-gate) | production deploy lane | CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ROOM_AGENT_CARD_SIGNING_KEY, ROOM_RECEIPT_TOKEN |
| staging.yml | push main, dispatch | staging deploy | CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ROOM_AGENT_CARD_SIGNING_KEY |
| rollback-prod.yml | dispatch (+ called) | recover to prior known-good code | CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ROOM_RECEIPT_TOKEN |
| deploy-drift.yml | hourly, dispatch | alarm when prod falls behind main | none |
| live-smoke.yml | 6-hourly, dispatch | prod smoke | GITHUB_TOKEN (read) |
| qa2-synthetic.yml | 6-hourly, dispatch | deep synthetic (stall probe, a11y, agent journey) | none |
| qa2-agent-eval.yml | PR(paths), daily, dispatch | agent eval suite | none |
| qa2-fuzz.yml | nightly, dispatch | OpenAPI fuzzing (Schemathesis) | none |
| qa3-gates.yml | PR(paths) | QA3 gates | none |
| mime-fuzz.yml | PR(paths), push main, nightly | MIME parser fuzz | none |
| zero-bug-gates.yml | PR | zero-bug gates (emits cloudflare context) | — |
| zero-bug-quarantine.yml | PR | quarantine mgmt (emits test context) | — |
| review-mechanical.yml | PR, workflow_run(test) | mechanical review report | GH_TOKEN (read) |
| pr-diff-size.yml | PR | large-diff justification gate | none |
| machine.yml | PR(paths), push main | agent-machine checks | none |
| relay.yml | PR(paths), push main | relay checks | none |
| trace-entry.yml | PR-target closed | bot PR → ROOM-TRACES.jsonl | TRACE_ENTRY_TOKEN (PAT) |
| room-work-sync.yml | PR-target closed | Room-Work claim → room receipt | ROOM_DOOR_SECRET |
| room-github-door.yml | issue_comment, 10-min, dispatch | GitHub↔room door | ROOM_DOOR_SECRET, GITHUB_TOKEN |
| merge-queue-receipts.yml | merge_group | (INERT — queue not enabled) | ROOM_DOOR_SECRET |
| merge-queue-eject-budget.yml | merge_group, PR closed | (INERT — queue not enabled) | GH_TOKEN |
| mcp-registry-publish.yml | push main, v* tags, dispatch | MCP registry publish (OIDC, no secret) | id-token:write |
| onboarding-probe.yml | weekly, dispatch | onboarding probe vs prod/staging | none |
| stall-probe.yml | dispatch | latency probe | none |
| soak-test.yml | weekly, dispatch | 15-min bounded soak + crash recovery | none |
| listing-check.yml | weekly, dispatch | directory listings | ROOM_OPS_POST_TOKEN |
| snippet-adoption.yml | weekly, dispatch | coordination-marker census | ADOPTION_SEARCH_TOKEN, ROOM_OPS_*, ANALYTICS_INGEST_TOKEN |
| answer-engine-check.yml | weekly, dispatch | asks ChatGPT/Claude/Perplexity/Grok | OPENAI/ANTHROPIC/PERPLEXITY/XAI_API_KEY, ROOM_OPS_*, ANALYTICS_INGEST_TOKEN |
| visual-baselines.yml | dispatch only | capture screenshot baselines | none |

## Merge gates (live branch protection, verified 2026-10-08)

- **Required checks**: `test`, `contract`, `lint`, `browser`, `cloudflare` (all must be green at the PR head).
- **Reviews**: advisory — `required_approving_review_count: 0` (PR #1786 retired the lander/merge-hold rules).
- **Conversation resolution**: required.
- **Admins**: enforced (no bypass).
- **`strict`: false** — PRs may merge while behind main (post-merge push runs are the backstop).
- **Code owners**: not required (`require_code_owner_reviews: false`); no CODEOWNERS file exists.

## Deploy authority

Anyone with workflow-dispatch rights can deploy any dual-green (test + schema-gate
push runs) main commit via `deploy-prod.yml` dispatch. Auto-deploy arms via
`[deploy-production]` merge-title prefix or `ROOM_AUTO_DEPLOY=1`. Deploys serialize
on `production-deploy` (never cancelled mid-flight). See D2.
