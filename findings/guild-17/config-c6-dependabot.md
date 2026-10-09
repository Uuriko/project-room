# Config C6: dependency-update automation hygiene

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Evidence
- No `.github/dependabot.yml`, no `renovate.json` / `.github/renovate.json*` in the repo.
- GitHub's default Dependabot **alerts** (repo setting) may still be on — not
  verifiable from the repo tree; the absence of a config file means no automated
  update PRs.

## Assessment
With 100% SHA-pinned actions (C5), the action layer does not auto-update — pins
rot only when a human bumps them. That's the secure posture, and the cost is
manual bump PRs. There is no automation to file them, so pins will age:
- `actions/checkout` v4 SHA, `setup-node` v4 SHA, etc. are from the v4 era;
  checkout v5 exists (mcp-registry-publish already uses a v5 SHA).
- Aging pins are not vulnerabilities by themselves (SHAs are immutable), but
  they miss security fixes in the action code itself (e.g. a checkout CVE would
  need a manual bump with no bot to propose it).

## Verdict: OBSERVATION, not a finding. Recommend a scheduled manual pin-review
(e.g. quarterly) or enabling Dependabot with a pinned-only policy, as a tap
item — not a BUG. The current state is the intended trade-off (pin everything,
bump by hand).
