# Secret flow S4: TRACE_ENTRY_TOKEN (fine-grained PAT) scope analysis
_head 6efe5fdbe_

## Injection lines
  21:# the TRACE_ENTRY_TOKEN repo secret. Until it exists every run skips with a
  73:          GH_TOKEN: ${{ secrets.TRACE_ENTRY_TOKEN }}
  79:            echo "trace-entry: secrets.TRACE_ENTRY_TOKEN is not set."
  82:            echo "the TRACE_ENTRY_TOKEN repo secret. GITHUB_TOKEN cannot be"
  87:            echo "::warning title=trace-entry skipped::TRACE_ENTRY_TOKEN is not set; no trace entry was written for PR #${PR_NUMBER}."
  113:          GH_TOKEN: ${{ secrets.TRACE_ENTRY_TOKEN }}

## Documented scope (workflow header)
  12:# Why a PAT and not GITHUB_TOKEN: GitHub suppresses workflow runs for
  15:# merge. A fine-grained PAT (or GitHub App token) triggers workflows normally.
  19:# One-time setup (needs the repo owner): create a fine-grained PAT with
  20:# contents:write and pull-requests:write on Uuriko/project-room, store it as
  80:            echo "One-time setup: create a fine-grained PAT (contents:write,"
  81:            echo "pull-requests:write on Uuriko/project-room) and store it as"
  106:          # PAT (not GITHUB_TOKEN): the push must trigger workflows normally.

## Script usage of the token

## Push destination check (branch prefix constraint)
  28:# - Trace PRs themselves are excluded via the trace-entry/ head-ref prefix,
  57:      !startsWith(github.event.pull_request.head.ref, 'trace-entry/')
  93:          BR="trace-entry/pr-${PR_NUMBER}"
