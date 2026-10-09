# WAVE-1000 guild-17 (ci-deploy) — rollup

_Date: 2026-10-08 · branch `wave1000/guild-17` · base `origin/main` @ b53c52af1 · 50 work units._

## Track 1 — workflow audit (20 units, 31/31 files)
`workflow-*.md` — one per workflow: triggers, permissions, action pinning, secrets, risk notes.
All 31 `.github/workflows/*.yml` audited. **100% SHA-pinned actions** (see config-c5).

## Track 2 — secret flow audit (9 units)
- secret-s1-deploy-prod.md — CLOUDFLARE_API_TOKEN / ROOM_AGENT_CARD_SIGNING_KEY / ROOM_RECEIPT_TOKEN traced to wrangler + signing; no log exposure
- secret-s2-staging-drift.md — staging.yml injects deploy secrets on push-to-main runs (the exfil vector, see gate-g5)
- secret-s3-room-door.md — ROOM_DOOR_SECRET / ROOM_RECEIPT_TOKEN consumers
- secret-s4-trace-token.md — TRACE_ENTRY_TOKEN PAT scope (repo-wide contents:write, code-confined)
- secret-s5-ops-tokens.md — ROOM_OPS_* / ANALYTICS_INGEST_TOKEN (artifacts checked)
- secret-s6-api-keys.md — OpenAI/Anthropic/Perplexity/xAI keys, raw-answer artifacts
- secret-s7-github-token.md — every GITHUB_TOKEN injection; all read-bounded
- secret-s8-machine-relay.md — no secrets in machine/relay
- secret-s9-probes.md — prod probes credential-free; trace-entry bot-PR pattern

## Track 3 — gate verification (9 units)
- gate-g1-required-checks.md — live protection: [test, contract, lint, browser, cloudflare]; reviews advisory (0)
- gate-g2-fork-safety.md — PASS: PR-code execution confined to read perms, no secrets
- gate-g3-schema-gate-gap.md — GAP: schema-gate not required; deploy-prod refuses such SHAs (self-mitigating)
- gate-g4-strict-false.md — GAP: behind-branch merges allowed; post-merge push runs are the backstop
- gate-g5-exfil-hole.md — **HOLE STILL OPEN**: no CODEOWNERS; fix commit b42febd80 sits unmerged on origin/wave400/audit; also needs require_code_owner_reviews flip (John tap). Exploit sketch verified.
- gate-g6-deploy-authority.md — deploy-prod semantics verified; trust boundary = merge gate
- gate-g7-secret-scan.md — PASS: scan in merge-blocking test suite, empty allowlist
- gate-g8-merge-queue-inert.md — PASS: doubly gated off
- gate-g9-supply-chain.md — PASS: pinning exemplary; cache isolation ok; soak-test SHA drift nit

## Config track (7 units)
- config-c1-dockerfiles.md — no Dockerfiles; substrates = Workers + systemd + Caddy
- config-c2-deploy-dir.md — PASS: hardened systemd units, no secrets in git
- config-c3-wrangler.md — PASS: no secrets in configs; misleading default env name (nit)
- config-c4-ci-scripts.md — check-name → job mapping documented
- config-c5-pinning-sweep.md — full 9-action pin inventory, all SHA
- config-c6-dependabot.md — no update automation; recommend periodic pin review (tap item)
- config-c7-trace-entry.md — PASS: bot-PR pattern correct, ~2× CI cost per merge

## Track 4 — docs (5 units)
- docs-d1-pipeline-overview.md — full workflow inventory + gate table + pipeline diagram
- docs-d2-deploy-path.md — staging→prod, wrangler envs, auto-deploy, receipts
- docs-d3-rollback-drift.md — rollback (schema-floor rule) + hourly drift alarm
- docs-d4-gotchas.md — 13 verified gotchas
- docs-d5-security-model.md — strengths, 6 residual risks, trust boundaries

## Room posts: 2/2 (charter + this rollup). BUG CONFIRMED posts: 0 (no new qualifying bugs; the exfil hole was already filed and is re-verified, not re-filed).
