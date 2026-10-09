#!/bin/sh
# FIX-32 — pre-push merge-base guard.
#
# Catches "fetched but didn't rebase" (COLLIDE-6 follow-on): before any push,
# fetch origin/main (bounded timeout) and require
#   git merge-base --is-ancestor origin/main HEAD
# Refuses the push with a rebase instruction when the assertion fails.
#
# Fail-open on unreachable network: if the fetch fails (offline, DNS down,
# bad remote), the hook prints a LOUD warning and allows the push. It must
# never block a push silently or because the network is gone.
#
# Install:
#   cp scripts/pre-push-merge-base.sh .git/hooks/pre-push
#   chmod +x .git/hooks/pre-push
#
# The hook ignores its pre-push stdin lines on purpose: the assertion is on
# HEAD, which is what is being pushed.
set -u

warn() {
  echo "pre-push hook WARNING: $1" >&2
}

# 1. Bounded fetch of origin/main. Non-fatal: any failure -> warn and allow.
FETCH_OK=1
if command -v timeout >/dev/null 2>&1; then
  timeout 30 git fetch --quiet --no-tags origin main 2>/dev/null || FETCH_OK=0
else
  git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 \
    fetch --quiet --no-tags origin main 2>/dev/null || FETCH_OK=0
fi

if [ "$FETCH_OK" -eq 0 ]; then
  warn "could not fetch origin/main (offline or unreachable?) — merge-base check SKIPPED, push allowed."
  exit 0
fi

if ! git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  warn "origin/main not found after fetch — merge-base check SKIPPED, push allowed."
  exit 0
fi

# 2. The assertion: HEAD must contain origin/main.
if git merge-base --is-ancestor origin/main HEAD 2>/dev/null; then
  exit 0
fi

echo "pre-push hook: push REFUSED — your branch is behind origin/main." >&2
echo "Rebase onto origin/main first, then push again:" >&2
echo "  git fetch origin && git rebase origin/main" >&2
exit 1
