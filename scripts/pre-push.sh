#!/usr/bin/env bash
# Fast pre-push gate for trunk-based pushes to main (~5 min).
# Usage: npm run gate            then: git push origin HEAD:main
# Rebases on origin/main, then runs the contract check (includes lint), and the unit
# tests your diff affects. Full unit, schema-gate and cloudflare still run
# on main after the push; red main is auto-reverted.
set -euo pipefail
git fetch -q origin main
git rebase -q origin/main
start=$SECONDS
npm run -s check
node scripts/verify-affected.mjs --base=origin/main --budget=180
echo "gate passed in $((SECONDS - start))s on $(git rev-parse --short HEAD); push with: git push origin HEAD:main"
