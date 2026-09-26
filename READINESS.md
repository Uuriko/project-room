# READINESS — submitted-state rot fix

Branch: `jill/submitted-rot-fix-2026-09-26` · worktree: `~/workspace/pr-submitted-rot`
PR: (to be opened) · Status: STOP before merge — protocol-behavior change, merge is John's call.

## What the fix does

Ground truth (`~/workspace/pr-claim-metrics/REPORT.md` finding #3): 29 of 32
rot claims were stuck in `submitted` state, and strike stamps only bit
`working`-state claims — a claim that never moved `submitted → working` had
**no expiry path at all**.

**Design decision: uniform submitted-state strike semantics** (not
auto-release). `docs/ROOM-PROTOCOL.md` §4 already says "when a lease expires
with no heartbeat, expiry is two-strike" with no state qualifier — the
`working`-only restriction was an implementation artifact, not protocol.
Auto-release was rejected because reducer-side time-based auto-transitions
would violate board-is-write-master (state must derive from comments, not
`--now`), and a new sweep-posted comment type would duplicate the strike
machinery. The existing F1–F5 forged-stamp hardening applies unchanged.

## Behavior delta

CHANGED:
- Reducer (`reduce_state`, `scripts/room`): strike-one/strike-two stamps now
  bite `working` **or** `submitted` held claims (lane != null).
- Sweep (`cmd_sweep`): strike candidates are now
  `(state == working or state == submitted) and lane != null and not terminal`
  — expired submitted claims get strike-one nudges and strike-two releases.
- Strike-two release on a submitted claim: lane → null (state already
  `submitted`), `released_at` set, `strike_one_at` cleared, files open for a
  fresh claim under a new task-id.
- Post-nudge STATUS heartbeat defends a submitted claim exactly like a
  working one (uniform heartbeat defense).
- Lease-bearing prose claims (state `submitted`, 12h lease) are now
  strike-eligible.
- Ignore message reworded: `claim not working/held` →
  `claim not held (working/submitted)`.
- `docs/ROOM-PROTOCOL.md` §4: explicit "Submitted-state claims are struck
  the same way" bullet.

UNCHANGED:
- Terminal claims (completed/cancelled, or carrying receipts): stamps still
  ignored (2026-09-19 guard intact).
- Suspended claims: not struck (explicit out-of-scope).
- Already-released claims (lane null): stamps still ignored.
- F1–F5 hardening (set-once strike-one, stamp clamping, grace measurement,
  heartbeat defense): untouched.
- Heartbeat-after-expiry-without-strike-one void rule (§4): untouched.
- Display surfaces (ROOM-STATE.md expiring-soon, room API `expiring`):
  untouched.

EDGE CASES:
- Submitted claim struck, then lane transitions submitted→working: normal
  working lifecycle continues (transition sets heartbeat_at).
- Submitted claim with strike-one, then same-state STATUS heartbeat:
  defends against strike-two (uniform with working).
- A lane can keep a submitted claim alive indefinitely with periodic STATUS
  posts (lease renews) — same as working claims today; not made worse.
- Backfill: existing ancient submitted rot claims (e.g. quill-s2's 9/16
  claims) will get strike-one on the next sweep after merge, then release
  4h later if silent.

## Test evidence

- New: `tests/room-submitted-rot.test.js` — 7 tests (S1–S7) in the
  F1–F5 style against the real reducer via `_parse`/`_state`.
  - Fail-pre (origin/main script): S1/S2/S3/S6/S7 FAIL for the intended
    reason (stamps ignored on submitted); S4/S5 PASS as controls.
  - Pass-post (branch script): 7/7.
- Existing: `tests/room-strike-hardening.test.js` + `tests/room-board-grammar.test.js`
  — 15/15 pass (no regression).
- Full suite: (pending — see CI status below).
- Enforcer verbs (sweep/rebuild/etc.) were NOT run on the branch — they fail
  closed when `scripts/room` differs from origin/main. Validation via the
  test suite only, per protocol.

## CI status

(pending — PR opened, hosted CI driving to green)

## Explicit ask for John

Please authorize merging this PR. It is a protocol-behavior change: after
merge, the room-watch sweep will start posting strike-one nudges on expired
submitted-state claims (29 currently rotting per the 2026-09-26 metrics
snapshot), releasing them 4h later if their lanes stay silent. No board
writes were made by this task; nothing fires until the branch merges.
