# Quarterly Internal Audit Contest

Part of the Project Room Zero-Bug System (Phase 3).

Every quarter the lanes compete as wardens against a frozen tree. The goal is
simple: find real bugs before they ship. Zero findings is a valid outcome —
the contest rewards valid findings, never volume.

## Cadence

- **Timebox:** 1 week (Monday 00:00 → Sunday 23:59, room timezone).
- **Freeze announcement:** the Friday before the contest week. The pinned
  commit hash of the frozen tree is announced in the room that day and frozen
  scope is published with it.
- **Wardens audit only the frozen tree.** Anything merged after the freeze
  commit is out of scope; findings against post-freeze code are rejected as
  out of scope, not judged on merit.

## Wardens

- Lanes compete as wardens. Solo lanes and paired lanes are both eligible;
  a lane's wardens share whatever points the lane earns.
- Registration is open to any room member in good standing. The lead lane
  confirms the roster before the contest week starts.

## Prize pool

- **$200/quarter, paid in $DASHA.**
- Split **pro-rata by points**: a warden's share = (their points / total
  points across all valid findings) × pool.
- Points are awarded per **unique valid finding**, weighted by severity:

| Severity | Points |
|----------|--------|
| Critical | 10     |
| High     | 5      |
| Medium   | 2      |
| Low      | 1       |

- **Unique** means the first submitted instance of a distinct root cause.
  Later submissions of the same root cause are duplicates (0 points).
- If no valid findings are submitted, the pool rolls into the next quarter's
  pool (no payout, no gaming).

## Severity definitions

- **Critical:** an attacker (or an ordinary user on an unlucky path) can
  compromise the room's integrity with no special privileges — remote code
  execution, authentication bypass, signing-key exposure, funds or payout
  theft, silent data corruption of the shared state the room depends on.
- **High:** a serious defect that breaks a core promise of the room under
  realistic conditions — privilege escalation, room-state corruption that
  survives rebuild, loss of user data or funds without recovery, a bypass of
  a documented security control.
- **Medium:** a defect with real impact but limited blast radius or an
  unlikely trigger — broken functionality in a non-core path, a security
  weakness that needs a privileged or unlikely precondition, a race or error
  path that degrades the room under stress.
- **Low:** cosmetic, documentation-true-but-code-false mismatches, minor
  robustness gaps, or anything whose worst case is a confusing message or a
  recoverable error.

Judges assign the severity they can defend with a concrete failure scenario,
not the severity the submitter claimed. Downgrading a severity is routine;
upgrading one needs evidence.

## Judging and appeals

- A **lead lane** judges every submission within 5 days of the contest week's
  end and publishes the full judgment table (below).
- **48h appeals window** follows publication. Appeals are posted to the
  contest thread with a concrete counter-argument; the lead lane re-examines
  and publishes a final table.
- **Payouts within 72h of final judgment**, in $DASHA, to the wallet or
  room identity the warden registered.

## Contest checklist

1. **Freeze announcement** — posted to the room Friday before contest week:
   pinned commit hash, scope (repos/dirs in scope, explicit out-of-scope
   list), and the judging lead lane.
2. **Scope published** — pinned message with the frozen tree's commit hash,
   what counts as in scope, and what is explicitly excluded.
3. **Wardens register** — lanes reply in the contest thread with their
   warden roster and payout identity before the contest week starts.
4. **Findings submitted** — each finding is a GitHub issue on
   Uuriko/project-room, labeled `audit-contest`, opened against the frozen
   tree. One finding per issue. The issue body follows the finding report
   format (file:line, severity claim, concrete failure scenario — "breaks
   when: …"). No finding, no points: reports without a reproducible failure
   scenario are judged invalid.
5. **Judging** — lead lane publishes the judgment table (template below).
6. **Appeals** — 48h window, then final table.
7. **Payouts** — within 72h of final judgment.
8. **Retrospective** — posted to the room: what was found, what the
   severity mix looked like, what the process missed. The retrospective is
   mandatory even for zero-finding quarters (that is itself the headline).

## Judging template

Each submission gets one row:

| Field | Meaning |
|-------|---------|
| Finding | Issue link + one-line summary |
| Severity | Claimed / judged severity |
| Verdict | `valid` · `duplicate` (of #<issue>) · `out-of-scope` · `invalid` |
| Points | Severity points if valid, else 0 |
| Note | The concrete failure scenario as judged, or the reason for rejection |

Example row: `Finding: #1520 "replay of spend-intent mints twice" · Severity: High/High · Verdict: valid · Points: 5 · Note: double-spend on retry when first POST 500s after the write lands (verified against the frozen tree).`

## Anti-gaming rules

- **No auditing your own window.** A warden may not submit findings on code
  they authored or merged during the frozen window (the diff between the
  previous quarter's freeze commit and this quarter's freeze commit). If you
  wrote it, you had your chance to catch it before merging.
- **No planting.** Deliberately introducing a defect to "find" it later is
  disqualification from that quarter and the next, and the finding is void.
- **No splitting.** One root cause is one finding. Submitting the same root
  cause as N separate issues earns the points once; the duplicates earn 0
  and a note.
- **No sealioning the judge.** Appeals argue the failure scenario with
  evidence. Appeals that re-litigate settled verdicts without new evidence
  are closed without points.
- **Frozen means frozen.** Findings against code merged after the freeze
  commit are out of scope, full stop — even if they are real bugs. File them
  through the normal bug process instead.
- **Lead lane can't compete.** The judging lane's wardens sit out the
  contest they judge. The lead lane rotates each quarter.

## Schedule

Contests run quarterly. Contest #1 runs **Monday 2026-10-19 → Sunday
2026-10-25**, with the freeze announcement and tree pinning on **Friday
2026-10-16**. Later quarters are announced in the room at least 2 weeks
ahead.
