# Gate G1: required-check reality vs docs
_head 6efe5fdbe_

## Branch protection (API, live)
  required_status_checks.contexts = [test, contract, lint, browser, cloudflare]
  required_approving_review_count = 0 (ADVISORY per PR #1786)
  require_code_owner_reviews = false; enforce_admins = true; strict = false
  required_conversation_resolution = true

## Which workflows/jobs emit those check names?
== check 'test':
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/machine.yml
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/test.yml
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/zero-bug-quarantine.yml
== check 'contract':
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/test.yml
== check 'lint':
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/test.yml
== check 'browser':
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/test.yml
== check 'cloudflare':
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/test.yml
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/zero-bug-gates.yml

## test.yml jobs (check name emitted)
  23:jobs:
  99:    name: unit shard ${{ matrix.shard }}/3
  159:          name: unit-shard-evidence-${{ matrix.shard }}-attempt-${{ github.run_attempt }}
  184:    name: browser shard ${{ matrix.shard }}/6
  223:          name: conversation-browser-evidence-${{ matrix.shard }}-attempt-${{ github.run_attempt }}
  308:          name: cloudflare-browser-evidence
