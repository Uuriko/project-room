# Ralph burndown loop (S4) — operator doc

The night-shift burndown loop from the software-factory brief (S4): when the
backlog (S2) is non-empty and no lane holds a conflicting claim, the loop
pulls the top ready item, dispatches a worker in an isolated worktree, and
the worker runs to PR. Tests/CI are the back-pressure; the loop stops at the
first red gate. Light factory: **the loop opens PRs only — it never merges,
never deploys.**

Driver: `scripts/ralph-loop.mjs`. This doc is the operator's manual.

## What one iteration does

```
backlog pull (top ready item; S1 overlap guard refuses on live claims)
        │
        ▼
worker slot reserved (cap: 2 concurrent) ── attempts tracked (cap: 3/item)
        │
        ▼
persistent worktree created: ~/workspace/pr-burndown/pr-burndown-<BL-ID>/
(branch <lane>/burndown-<bl-id>-<date>, TMPDIR inside the worktree)
        │
        ▼
driver prints:  (1) the exact [lane][claim] text to post on #266
                (2) a worker prompt template for a FRESH worker
        │
        ▼
fresh worker (fresh agent context, no inherited transcript):
  claim → implement → full test suite → open PR → post receipt
        │
        ▼
operator/coordinator: heartbeat while it runs, release when done,
  `scripts/room backlog done <BL-ID> --pr <N>`; merge stays human-gated
```

The driver itself never implements, never posts, never pushes. Dispatch
prepares everything; a fresh worker executes.

## Safety invariants (non-negotiable)

1. **No auto-merge.** There is no merge code path in the driver or the worker
   template. PRs merge only via the existing human/coordinator gate on
   full-green exact-head CI.
2. **No deploy, no production touch.** The worker template forbids it; the
   driver has no deploy affordance at all.
3. **No secrets in prompts, logs, PR bodies, or board comments.** Everything
   the driver echoes passes through `redactSecrets()` (GitHub/Slack/Stripe/
   AWS/Bearer/`rak_`/`pri_` shapes → `<redacted>`). The worker template
   carries the same rule.
4. **Bounded concurrency: 2 workers max** (configurable via `--max-workers`,
   default 2 — the skeptics' ceiling from the brief). Slots heartbeat;
   slots idle longer than `--stale-after-hours` (default 12h) are reaped.
5. **Bounded attempts: 3 per item** (`--max-attempts`). An exhausted item is
   moved to `## blocked` in BACKLOG.md with a `blocked:` trailer and left
   for a human. The loop never spins on a poisoned item.
6. **Collision-aware.** `scripts/room backlog pull` refuses when the item's
   files are held live by another lane (S1 overlap guard) — the refusal is
   the verification. The loop never reorders the backlog (ordering is John's
   lever); on refusal the tick exits and the item waits.
7. **Persistent worktrees, never /tmp.** Worker worktrees live under
   `~/workspace/pr-burndown/` (configurable `--worktree-root`); every test
   command runs with `TMPDIR=<worktree>/.tmp` (the shared /tmp is a small
   tmpfs and gets reaped — tests die with SQLITE_FULL otherwise).
8. **Fresh context per iteration.** Each burndown item goes to a fresh worker
   (no inherited transcript) — the room's subagent pattern, matching the
   brief's "fresh context per iteration = fresh subagent per item".

## Named routines (default pick order)

Routines, not a generic loop — each is a backlog *template* with a
one-sentence brief. The driver classifies the pulled item; `--routine`
accepts only a top item of that routine:

1. **openapi-drift** — reconcile `docs/openapi.yaml` against live server routes.
2. **docs-gap** — fill documentation gaps for merged-but-undocumented work.
3. **stale-todo** — sweep stale TODOs / dead code; every removal stays green.
4. **general** — anything else well-scoped.

## Running one supervised iteration

```bash
# 0. From a repo checkout (the driver never touches the shared tree itself):
cd ~/workspace/pr-ralph-loop

# 1. Dry-run: prints the plan, the overlap verdict, and a prompt preview.
#    Changes nothing: no claim posted, no slot reserved, no worktree made.
TMPDIR=$PWD/.tmp node scripts/ralph-loop.mjs --dry-run

# 2. Dispatch: marks the top item claimed (via `backlog pull`), reserves a
#    worker slot, creates the persistent worktree, prints the worker brief.
TMPDIR=$PWD/.tmp node scripts/ralph-loop.mjs --dispatch

# 3. Post the printed claim text as a comment on Uuriko/project-room#266,
#    then hand the printed worker prompt to a FRESH worker (new agent,
#    no inherited transcript).

# 4. While the worker runs (optional, keeps the slot from going stale):
node scripts/ralph-loop.mjs --heartbeat BL-002

# 5. When the worker's PR is opened and receipt posted:
node scripts/ralph-loop.mjs --release BL-002
scripts/room backlog done BL-002 --pr <number>
# Then review + merge the PR through the normal human gate.
```

Check loop state any time: `node scripts/ralph-loop.mjs --status` (`--json`
for machine-readable).

If the worker's suite can't go green within the attempt budget, the worker
stops, posts a STATUS note on #266 describing the blocker, and leaves the
item for a human — the driver counts the attempt and will block the item
after `--max-attempts`.

## Night-shift cron spec (NOT activated)

> **Explicit: no cron job or scheduled job was created by this change.**
> What follows is a spec awaiting a separate, explicit go-ahead. Activating
> it is a deliberate operator decision, not a default.

When approved, the night-shift tick would be a cron (e.g. every 30 min
alongside room-watch, or a few times nightly) running:

```bash
cd <canonical-repo-checkout> && node scripts/ralph-loop.mjs --dispatch
```

Tick semantics:
- If no ready items, at worker cap, or the top item's files are held live:
  exit quietly (exit 0/2, one log line). No noise on idle ticks.
- On dispatch: print the worker brief to the cron log; the cron spawner
  hands the prompt to a fresh worker agent (the spawn itself lives at the
  cron layer, not in this repo — this repo ships the driver + template).
- A reconciliation step per tick: `scripts/ralph-loop.mjs --status` to reap
  stale slots; workers that finished post their own receipts and the
  operator runs `--release`.

Why the cron stays manual for now: the spawn step needs the cron layer's
agent-spawning ability, and unattended dispatch deserves a supervised
shakedown (a few `--dispatch` runs with a human watching) before it runs
while everyone sleeps. The brief's own verdict: light factories keep the
gates; this loop keeps them too.

## Files

- `scripts/ralph-loop.mjs` — the driver (this doc's subject).
- Loop state: `<worktree-root>/.ralph-loop-state.json` (default
  `~/workspace/pr-burndown/.ralph-loop-state.json`) — worker slots with
  heartbeats, per-item attempt counts. Written atomically; safe to delete
  (the loop re-derives; in-flight workers keep their own claims).
- Tests: `tests/ralph-loop.test.js` — routine pick order, secret redaction,
  slot reaping/caps, attempt exhaustion, and the worker template's hard
  invariants (prompt-byte contract).

## Relationship to S1/S2

- S2 (`scripts/room backlog`, `BACKLOG.md`) feeds the loop; without it the
  loop has nothing to eat.
- S1 (`scripts/room overlaps`, live claim registry) guards it; the pull
  verb already refuses on live file overlap, so the loop can't collide
  with a working lane.
