#!/bin/bash
# test-env.sh — safe test environment wrapper for project-room.
#
# /tmp is a 512MB tmpfs shared by all agents and is actively reaped: scratch
# files vanish mid-task and parallel test runs die with SQLITE_FULL /
# database-or-disk-is-full, producing hundreds of spurious failures.
#
# This wrapper points TMPDIR at a worktree-local .tmp/ directory (persistent,
# not reaped, not size-constrained like /tmp) and ensures it exists.
#
# Usage:
#   scripts/test-env.sh npm test                    # run a command
#   scripts/test-env.sh node --test tests/foo.test.js
#   source scripts/test-env.sh                      # set up env in current shell
#
# The .tmp/ directory is gitignored (see .gitignore).

# Resolve the repo root (the directory containing this script's parent).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TMPDIR="$REPO_ROOT/.tmp"
mkdir -p "$TMPDIR"

# Also set XDG_RUNTIME_DIR if unset, since some tools fall back to /tmp.
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  export XDG_RUNTIME_DIR="$TMPDIR"
  mkdir -p "$XDG_RUNTIME_DIR"
fi

# If sourced, we're done. If executed with args, run them.
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  return 0 2>/dev/null || exit 0
fi

if [ $# -eq 0 ]; then
  echo "TMPDIR=$TMPDIR (ready)"
  exit 0
fi

exec "$@"
