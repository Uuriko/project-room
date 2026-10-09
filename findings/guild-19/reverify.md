# Re-verify rollup (guild-19)

10 wave branches touching validation code, each rebased (scratch worktree) onto
origin/main @ b53c52af1, affected suite re-run, diff adversarially reviewed.
Per-unit logs: `reverify-<n>.log`; full server diffs: `reverify-<n>.diff`.

| # | Branch | Rebase | Tests | Adversarial review |
|---|---|---|---|---|
| R1 | origin/wave500/presence | ok | agent-presence-http + presence: pass | `stream_limit` 429 moved, re-added. No weakening. |
| R2 | origin/wave500/presence-w2-pump | ok | same: pass | Same as R1. |
| R3 | upstream/wave300-fanout-perf | ok | agent-presence-http: pass | `stream_limit` 429 moved, re-added. No weakening. |
| R4 | upstream/wave400/elegant-http-a | ok | http-public-dm + id-sec-http: pass | 285-line http refactor: OAuth paths unified behind parameterized `provider`; all 401/400 checks preserved (verified each removed line re-added). Behavior change (linking flow) is guild-03's slice, not mine. |
| R5 | upstream/wave400/elegant-rooms-a | ok | attachments: pass | `denyGuestFiles()` refactor of the guest 403s — same denial, one place. |
| R6 | upstream/wave400/elegant-server | ok | attachments: pass | Same as R5 (merge of elegant-rooms-a). |
| R7 | origin/wave300/telemetry-prod | ok | diagnostics: pass | Additive: tripwire endpoint + write-limiter penalty box. Rate-limit 429 preserved. |
| R8 | origin/wave300/fix12-unprivileged-succession | **CONFLICT** | work-claim-board: pass (on un-rebased tip) | 4-line route addition (work-claims/succeed). No checks removed. **Needs rebase help before merge.** |
| R9 | origin/wave300/fix1-commands-failfast | ok | http-public-dm: pass | New 503 `commands_saturated` gate *before* body read — correct fail-fast ordering (refused commands are never applied). |
| R10 | origin/wave300/sharded-claim-boards | **CONFLICT** | work-claim-board: pass (on un-rebased tip) | Sharded-boards route literal. Owner-only claim-cap 403 preserved (message reworded). **Needs rebase help before merge.** |

## Breakage found: none in validation logic

No branch weakens, removes, or bypasses an input validator. The two rebase
conflicts (R8, R10) are merge-shepherd lane work, not validation breakage —
flagged here so they aren't lost: both branches' affected suites pass on
their current tips.

## Method notes

- Scratch worktrees at `~/workspace/scratch-g19-<n>/` (persistent, not /tmp),
  removed after each unit. No orphan worktrees remain.
- Rebase conflicts were aborted (`git rebase --abort`); the branch was tested
  as-is and the conflict reported rather than resolved (resolving another
  lane's conflicts is out of slice).
- `TMPDIR` pointed inside each scratch worktree per repo convention.
