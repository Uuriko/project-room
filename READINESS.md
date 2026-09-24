# READINESS — claims-board strike-protocol hardening

Branch: `jill/claims-strike-hardening-2026-09-24`
Worktree: `~/workspace/pr-claims-strike-hardening` (persistent; own worktree, never /tmp)
Base: `origin/main` @ `dee9fd07`
Modeled protocol per fuzzer: `scripts/room` @ `f16d22bb` — findings re-verified against current `origin/main` before fixing (reclaim reducer, sweep, and state-mapping code unchanged between the two).

**Status: ready for review. Do NOT merge or deploy (2026-09-22 hold stands). No PR opened, nothing posted to #266.**

## Root causes → fixes (all in `scripts/room`, reducer `reduce_state`)

| Finding | Root cause | Fix |
|---|---|---|
| F1/F2 — strike-stamp replay | Reclaim reducer applied `strike_one_at = stamp_ts` unconditionally. A forged replay with a fresher stamp moved `strike_one_at` past the agent's heartbeat (nullifying the sweep's heartbeat defense → wrongful strike-two); a stale stamp moved it backwards (shortening the documented 4h grace); fresh stamps could extend the grace indefinitely. Stamps are unauthenticated comment text. | **Set-once semantics** in the reducer: the first strike-one stamp wins; replays are logged (`strike-one replay ignored: ...`) and ignored. Stamp additionally clamped to not-after the comment's own timestamp (future-dated = forged) and refused if unparseable (never recorded). |
| F3 — lone strike-two | Reducer honored `strike_two` on any working+held claim — the strike-one → 4h grace → strike-two lifecycle lived only in sweep behavior, never in the reducer. One forged `<!-- room:strike-two:… -->` released a live claim instantly. | Reducer now requires: (a) a recorded `strike_one_at`, (b) ≥14400s elapsed since it **on reducer timestamps**, (c) no heartbeat after the nudge. Lone/early/post-heartbeat strike-twos are logged (`ignored: …`) and change nothing. |
| F4 — spurious strike-one | State's `lease_expires_at` was computed from `claim_at` (heartbeat-ignorant) while the reducer's `lease_exp()` is heartbeat-aware. Sweep reads `lease_expires_at`, so actively heartbeating claims got spurious nudges, and every expiry surface misreported. | `lease_expires_at` now uses the heartbeat-aware `lease_exp($v)` (expiry from last heartbeat, falling back to claim time). Same field every surface reads — sweep, ROOM-STATE.md expires column, metrics `expiring`. |
| F5 — silent malformed | A `STATUS:` with no fenced `room-claim` block and no ACK parsed as kind `malformed` and fell through `else . end` — the only claim-path input absorbed with no log, no refusal. | New `malformed` branch: refusal-style loud log entry (`kind:"malformed", ok:false, errors:[…]`), nothing registered. |

## Test evidence

New: `tests/room-strike-hardening.test.js` — 8 tests driving the **real** reducer via the `_parse`/`_state` test verbs, each mirroring a fuzzer minimal repro:

- F1 fresh-stamp replay after a post-nudge heartbeat → `strike_one_at` unchanged
- F2 stale-stamp replay → `strike_one_at` not moved backwards
- F3 lone strike-two (no strike-one) → claim stays `working`, lane intact
- F3 strike-two inside the 4h grace → ignored
- F3 strike-two after a post-nudge heartbeat → ignored
- F3 control: strike-one + full grace + no heartbeat → **still releases** (legit sweep lifecycle preserved)
- F4 heartbeat at T+5h on a 6h lease → `lease_expires_at` = heartbeat+6h (what the sweep reads)
- F5 bare `STATUS:` → one loud `malformed` log entry, claim untouched

Results: **8/8 FAIL on the pre-fix script** (`git show HEAD:scripts/room`), **8/8 PASS post-fix**.

Existing suite: `TMPDIR=<worktree>/.tmp node --test` (full, root) — see `.tmp/full-suite.log`.
Sweep/clock/grammar-adjacent files (`room-sweep-dry-run`, `room-sweep-terminal`, `sla-sweep`, `sla-sweep-hooks`, `recovery-audit-sweep`, `room-clock-skew`, `room-board-grammar`, `claim-validate` incl. the `validate_claim` parity check): 75/75 pass. (Full-suite result appended when it completes.)

## Behavior deltas (deliberate)

1. **Duplicate strike-one no longer resets the grace clock** — previously a re-posted strike-one restarted the 4h window (the code already flagged this as a hazard); now the first stamp wins. The sweep only posts strike-one when none is recorded, so genuine flow is unchanged.
2. **Forged strike stamps are now visible** — ignored replays/early/lone strike-twos and unparseable stamps produce explicit log entries instead of silently mutating or vanishing.
3. **`lease_expires_at` extends with heartbeats** — the documented rule ("heartbeats keep the lease alive") now holds in the state field the sweep and all render surfaces read; no more spurious nudges for heartbeating claims.
4. **Sweep's strike-two posting path is unaffected**: sweep still only posts strike-two when `now − strike_one_at > 14400` with no post-nudge heartbeat; since the comment lands after that decision, the reducer's timestamp-based grace check (`≥ 14400`) accepts it. Verified by the F3 control test.

## Notes for the merger

- History replays cleanly through the fixed reducer: old genuine strike-one comments (stamp ≈ post time) are kept by the min(stamp, comment-time) clamp; old sweep-posted strike-twos still satisfy the grace on timestamps.
- Enforcer verbs (`sweep`, `rebuild`, …) fail closed on this branch vs `origin/main` by design (`guard_enforcer_freshness`) — live-board verification of sweep behavior must happen **after** merge. No live verbs were run from this branch.
- Fuzzer model note: `~/workspace/claims-fuzzer/model.py` ports the *pre-fix* reducer; re-running the fuzzer differential against the new code is follow-up work, not done here.
- jq-in-bash hazard hit twice while editing: **never use an apostrophe inside jq comments/strings in `scripts/room`** — it terminates the enclosing single-quoted bash string (manifested as `syntax error near unexpected token`). Worth a lint note.
