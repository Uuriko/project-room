#!/usr/bin/env bash
# cone.sh — affected-test cone prototype (W2, integration guild)
# Usage: cone.sh <worktree-dir> <base-ref> <head-ref>
# Emits a newline-separated list of test files (relative to worktree) on stdout.
# Diagnostics go to stderr.
#
# Mapping rules, in priority order:
#   A. tests/** files added/modified in the diff are always in the cone.
#   B. For each changed source file, find tests that import/require the module
#      (match on the file's basename stem, e.g. server/work-claim-routes.mjs
#      matches tests containing "work-claim-routes" in an import/from string).
#   C. Stem-name match: tests/<stem>.test.{js,mjs} or tests/*<stem>*.test.*
# Changed non-test files with no test referencing them are reported to stderr
# as coverage gaps (candidate for: add a test, or expand the cone).
set -euo pipefail

WT="${1:?usage: cone.sh <worktree> <base> <head>}"
BASE="${2:?usage: cone.sh <worktree> <base> <head>}"
HEAD="${3:?usage: cone.sh <worktree> <base> <head>}"

cd "$WT"
CHANGED="$(git diff --name-only "$BASE" "$HEAD" -- . || true)"
if [ -z "$CHANGED" ]; then
  echo "cone: empty diff $BASE..$HEAD" >&2
  exit 0
fi

CONE="$(mktemp)"; GAP="$(mktemp)"; trap 'rm -f "$CONE" "$GAP"' EXIT

while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    tests/*.test.js|tests/*.test.mjs)
      echo "A:$f" >> "$CONE" ;;        # Rule A: test touched directly
    *.js|*.mjs)
      # Rule B/C keyed on the full module path (dir + stem), NOT the bare stem:
      # a bare stem like "index" matches every index.mjs in the repo.
      STEM="$(basename "$f" | sed -E 's/\.(js|mjs)$//')"
      DIR="$(dirname "$f")"
      MOD="$([ "$DIR" = "." ] && echo "$STEM" || echo "$DIR/$STEM")"
      FOUND=0
      # Rule B: tests importing this module (import/from/require) — the import
      # string must contain "<dir>/<stem>" as a full path segment sequence.
      while IFS= read -r t; do
        [ -n "$t" ] || continue
        echo "B:$t" >> "$CONE"; FOUND=1
        [ -n "${CONE_DEBUG:-}" ] && echo "debug: B $t <- $f" >&2
      done < <(grep -rlE "(import|from|require\()[^'\"\n]*['\"][^'\"]*${MOD}(\.mjs|\.js)?['\"]" tests/ --include='*.test.js' --include='*.test.mjs' 2>/dev/null || true)
      # Rule C: stem-named test files — the stem must be followed by .test or a
      # separator, so "room" does not match "roommates".
      STEMRE="$(printf '%s' "$STEM" | sed 's/\./\\./g')"
      while IFS= read -r t; do
        [ -n "$t" ] || continue
        echo "C:$t" >> "$CONE"; FOUND=1
        [ -n "${CONE_DEBUG:-}" ] && echo "debug: C $t <- $f" >&2
      done < <(ls tests/*"${STEM}"*.test.js tests/*"${STEM}"*.test.mjs 2>/dev/null | grep -E "/${STEMRE}(\.test|[-_.])" || true)
      [ "$FOUND" -eq 0 ] && echo "$f" >> "$GAP"
      ;;
    *) echo "$f" >> "$GAP" ;;          # non-code (docs, html, assets): gap by policy
  esac
done <<< "$CHANGED"

# Emit deduped, sorted relative paths (strip rule tags)
sed 's/^[ABC]://' "$CONE" | sort -u

NGAP="$(sort -u "$GAP" | wc -l)"
if [ "$NGAP" -gt 0 ]; then
  echo "cone: coverage gaps (changed files with no test reference):" >&2
  sort -u "$GAP" | sed 's/^/  gap: /' >&2
fi
