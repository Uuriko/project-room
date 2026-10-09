# CI/CD security model summary (guild-17 reference)

_Date: 2026-10-08 · verified against `origin/main` @ b53c52af1._

## What's strong

- **100% SHA-pinned actions** across all 31 workflows — no tag/branch refs, no
  `docker://`, no exotic third-party actions.
- **Least-privilege permissions**: `contents: read` baseline; write grants only
  where provably needed (`issues: write` for the door, ledger-commit for the
  (inert) merge-queue budget). PR-triggered workflows that execute fork code run
  with read-only perms and no deploy secrets.
- **Secret hygiene**: no secrets in git (empty secret-scan allowlist, scan wired
  into the merge-blocking test suite); deploy secrets only in GitHub Secrets +
  dashboard vars; wrangler configs carry no secrets.
- **Deploy gate**: dual-green (test + schema-gate push runs) on the exact SHA,
  main-ancestor check, tip check, serialized deploys never cancelled mid-flight,
  smoke + receipt, schema-floor-bounded rollback.
- **Bot-PR pattern** (trace-entry) correctly navigates the protection-vs-automation
  tension: PAT defeats GITHUB_TOKEN suppression, base-context execution, loud
  failures.

## Residual risks (all verified, none newly filed)

1. **Workflow-rewrite exfiltration (OPEN, BUG CONFIRMED already filed).** No
   CODEOWNERS + advisory reviews + `staging.yml` running on push-to-main with
   `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`/`ROOM_AGENT_CARD_SIGNING_KEY`.
   Fix exists unmerged on `origin/wave400/audit` (b42febd80); also needs the
   `require_code_owner_reviews` admin flip. See `gate-g5-exfil-hole.md`.
2. **`strict: false`** — behind-branch merges; post-merge push runs are the
   backstop. Accepted trade-off at this velocity; needs John's tap to change.
3. **`schema-gate` not a required check** — mergeable when red; deploy-prod
   refuses to ship such SHAs, so the blast radius is "stuck deploys + drift
   alarms," not broken prod. Needs John's tap to add.
4. **TRACE_ENTRY_TOKEN** is a repo-wide contents:write PAT confined only by
   workflow code (branch-prefix discipline). Narrow if GitHub ever offers
   branch-scoped PATs.
5. **No automated action-pin updates** (no dependabot/renovate config) — pins age
   without a bot to propose bumps. Recommend a periodic manual pin review.
6. **`[deploy-production]` title trigger** is social: merge rights ⇒ auto-deploy
   arming. The trust boundary is the merge gate itself, which is where it belongs.

## Trust boundaries, stated plainly

- **Merge gate** = required CI (test/contract/lint/browser/cloudflare) + conversation
  resolution. Everything downstream (staging auto-deploy, `[deploy-production]`
  auto-deploy, MCP registry publish) trusts it.
- **Deploy gate** = dual-green SHA + tip checks, enforced inside deploy-prod.
- **Human taps** = repo settings (strict, code owners, required checks), deploy
  lane overrides (probe_override), and John's explicit taps (money, identity,
  Dasha deploys).
