#!/bin/bash
# Fake `gh` for tests/claims-state-machine.property.test.js.
#
# Lets the property tests drive the REAL `scripts/room sweep --dry-run`
# binary against fast-check-generated boards without touching the network.
# Only the calls sweep's read path makes are served:
#   gh api -i /rate_limit                        -> Date header (board clock)
#   gh api --paginate repos/.../issues/.../comments -> canned comments JSON
#   gh api repos/.../issues/...                  -> {"comments": N}
# Unexpected calls fail; the fake cannot silently accept writes.
#
# Env: FAKE_GH_COMMENTS (JSON array of comment objects),
#      FAKE_GH_DATE (HTTP-date string, e.g. "Sat, 26 Sep 2026 21:30:00 GMT").
set -u
jqfilter=""
mode=""
prev=""
for a in "$@"; do
  case "$a" in
    --jq) prev="jq" ;;
    *)
      if [ "$prev" = "jq" ]; then
        jqfilter="$a"; prev=""
      elif [ "$prev" = "skip1" ]; then
        prev=""
      else
        case "$a" in
          -i|--paginate|api) ;;
          -X|-f) prev="skip1" ;;
          /rate_limit) mode="rate" ;;
          repos/*/issues/*/comments*) mode="comments" ;;
          repos/*/issues/*) mode="issue" ;;
        esac
      fi
      ;;
  esac
done

if [ "$mode" = "rate" ]; then
  printf 'HTTP/2 200\r\nDate: %s\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{}\n' \
    "${FAKE_GH_DATE:-Sat, 26 Sep 2026 21:30:00 GMT}"
  exit 0
fi

[ -n "$mode" ] || { printf "unexpected gh call: %s\n" "$*" >&2; exit 91; }
body="{}"
if [ "$mode" = "comments" ]; then
  body="${FAKE_GH_COMMENTS:-[]}"
elif [ "$mode" = "issue" ]; then
  body="$(printf '%s' "${FAKE_GH_COMMENTS:-[]}" | jq -c '{comments: length}')"
fi

if [ -n "$jqfilter" ]; then
  printf '%s' "$body" | jq "$jqfilter"
else
  printf '%s' "$body"
fi
