# Merge Queue Design — Uuriko/project-room (BL-004)

**Status:** design spec. No production behavior changes. Nothing in this
document enables the queue — that is John's one-click tap (§6), which he can
take whenever he is ready (Arizona through Oct 1; no timeline is assumed).

**Scope:** everything up to the tap. The spec, the queue-readiness patch, and
the inert bot prototype all land as normal PRs under the room's existing
exact-head green-CI rule. The tap itself is a single repo-settings change by a
repository admin (John).

**Related:** BL-004 (GitHub-native merge queue, awaiting John's tap).
Reference: GitHub Docs, "Managing a merge queue"
(<https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue>).

## 0. Current state (verified 2026-09-26, read-only API)

- Branch protection on `main` (legacy branch-protection API): required status
  checks `test`, `contract`, `lint`, `browser`, `cloudflare` (GitHub Actions,
  app_id 15368), **strict = true** ("require branches to be up to date").
- No repository rulesets exist. Merge queue is **not** enabled.
- Room merge rule today: merge ONLY on exact-head full green CI (the PR head
  SHA must be green across the required suite; squashes are re-verified at the
  exact head before the merge button is pressed).

Consequence: today's gate is *per-PR, at PR-head time*. Under main's velocity
(10–20 lane PRs/day), a PR that was green at 14:00 can be stale by 14:30 after
another lane merges — the classic race the queue exists to kill. The design
below keeps the exact-head gate and moves it to *merge time*, which is
strictly stronger.

## 1. Queue semantics

### 1.1 What "queued" means for a PR

A PR is **queued** when a lane with write access presses **"Merge when ready"**
(or calls the API equivalent) after the PR has passed all required branch
protection checks at its head. From that moment the PR is owned by the queue,
not the lane:

- The lane MUST NOT push new commits to a queued PR (a push ejects it and
  restarts its validation).
- The queue builds a **prospective merge commit** on a temporary branch
  (`gh-readonly-queue/main/pr-<N>-<sha>`) containing: latest `main` HEAD +
  all entries ahead in the queue + this PR's changes, in order.
- When the required checks pass on that temporary branch, the queue merges the
  group into `main` (squash, §6) and the PR closes as merged. Dequeue and merge
  are the same event — there is no separate "dequeue" step.

### 1.2 Ordering

- **FIFO, strictly.** Entries merge in the order they were added. This is the
  room's only ordering — no priority lane, no release lane.
- **No release-lane priority.** Rationale: priority preemption re-orders the
  commit graph and forces a full rebuild of every in-progress group (GitHub
  documents this for jump-to-top: "a full rebuild of all in-progress pull
  requests"). With the room's heavy CI suite (Playwright browser gate +
  cloudflare gate), a rebuild storm costs more than it saves. Urgent fixes use
  the normal path; if genuinely urgent, they are small, green fast, and still
  go through the queue.
- **Jump-to-top exists in the platform but is banned by room convention.**
  Anyone with write access *can* click it in the GitHub UI; the room treats it
  as a process violation (same class as hand-merging locally — see
  `docs/GITHUB-HYGIENE.md`). Reorder churn is visible on the board as
  destroy/recreate pairs in the opt-in bot notices (§7.2).

### 1.3 Who may enqueue and dequeue

- **Enqueue:** anyone with **write access** to the repo, on a PR that has
  passed all required checks at its head. In practice: the PR's lane, after
  exact-head green CI (unchanged from today — the lane still verifies before
  enqueueing; the queue then re-verifies at merge time).
- **Dequeue (eject):** only the **queue itself** or the **entry's lane**:
  - The queue ejects automatically on: failing required checks on the
    prospective merge commit, status-check timeout, or a branch-protection
    failure it cannot resolve (e.g. the PR went dirty — §3).
  - The lane ejects via the queue UI/API ("Remove from queue"). Used when the
    lane needs to push a fix: eject first, push, re-verify, re-enqueue.
- **What nobody may do:** merge a queued PR by hand (`gh pr merge`, the green
  button, or local merge+push) while it is in the queue. Hand-merging a queued
  entry breaks the queue's commit-graph accounting and silently drops the
  re-verification. Same rule as GITHUB-HYGIENE's hand-merge ban, extended.

## 2. Exact-head re-verification on each dequeue (the quality gate, preserved)

This is the room's non-negotiable gate, and the queue **strengthens** it rather
than bypassing it. How:

1. **The queue re-runs the full required suite against the prospective merge
   commit.** GitHub dispatches a `merge_group` event (`checks_requested`) for
   each temporary branch. Our CI *must* listen to it — see the readiness patch
   below. The temporary branch contains exactly what would land on `main`
   (latest main + queue entries ahead + this PR), so a green `merge_group`
   run is proof that the *merge result* is good, not just the PR in isolation.
2. **ALLGREEN grouping.** The queue is configured with "Only merge non-failing
   pull requests" ON (the platform's ALLGREEN grouping strategy): every entry
   in a group must satisfy the required checks; one failure ejects the failing
   entry and rebuilds the rest without it. No HEADGREEN shortcut — the room
   does not trade gate strength for CI savings.
3. **Small groups.** min 1 / max 2 entries per merge group (§6). A group of 2
   means at most one *other* lane's changes ride along untested-in-combination
   — and they *are* tested in combination, on the temporary branch. This keeps
   failure attribution obvious (a red group is at most 2 PRs to bisect).

### 2.1 Readiness patch (lands BEFORE the tap, inert without it)

GitHub is explicit: *"You must use the `merge_group` event to trigger your
GitHub Actions workflow when a pull request is added to a merge queue…
Otherwise, status checks will not be triggered… The merge will fail as the
required status check will not be reported."*

`.github/workflows/test.yml` (which owns the required checks `test`,
`contract`, `lint`, `browser`, `cloudflare`) needs this trigger added:

```yaml
on:
  pull_request:
  merge_group:
    types: [checks_requested]
  push:
    branches: [main]
```

Behavior without the queue: `merge_group` events never fire (the platform only
dispatches them for queue entries), so this is a no-op until the tap. It must
land before the tap, otherwise the first queued entry can never go green.
(This patch is deliberately NOT in this PR — `.github/workflows/test.yml` is
currently held by RC-2026-09-26-965, the #1076 reconcile; the exact diff above
is ready for that lane or any lane to apply.)

### 2.2 What "exact-head" means under the queue

Today: the PR head SHA is green → merge that SHA. Under the queue: the
**prospective merge commit** (temp branch HEAD) is green → the queue merges
*that commit's tree*. The guarantee the room cares about — "what lands on main
passed the full suite" — is preserved, and extended across queued entries: the
suite runs against main+entry1+entry2 together, which today's per-PR gate never
did. Post-merge `push` CI on main stays as the last line of defense (unchanged).

### 2.3 The strict=true change

Today `main` requires branches to be **up to date** (strict). The merge queue
**replaces** that setting: the platform provides the same freshness guarantee
by re-verifying against latest main, and GitHub's queue is incompatible with
strict required checks (the queue owns freshness; strict would demand authors
rebase manually, defeating the queue). The tap (§6) therefore flips strict →
false **at the same time** it enables the queue. There is no window where
neither freshness mechanism applies — it is one settings save.

## 3. Conflict handling

### 3.1 A queued PR goes dirty (loses mergeability)

When `main` moves under a queued entry such that it no longer merges cleanly:

1. The queue detects the unresolvable branch-protection failure and **ejects
   the entry automatically**. GitHub posts the reason on the PR timeline
   ("removed from the merge queue because…").
2. The entry's claim (§5) stays **open** — ejection is not a failure of the
   work, it is a rebase request. The lane is notified via the PR timeline and
   the queue-status surface (§5.3).
3. **Rebase-then-reverify, explicitly:**
   - Lane rebases the PR branch onto latest `main` and force-pushes
     (`git pull --rebase origin main && git push --force-with-lease`).
   - The push re-triggers the normal `pull_request` CI run. **Known platform
     behavior (room-verified): GitHub silently skips creating `pull_request`
     workflow runs for PRs in a conflicting state** — so a dirty PR may show
     *no* CI runs at all, which looks like "CI hasn't run" but is actually
     "the PR is dirty." After the rebase the PR is clean, runs are created
     again, and the lane waits for **full green at the new head**.
   - Only then the lane re-enqueues ("Merge when ready"). The queue re-verifies
     from scratch against the new prospective merge commit.

   Skipping the middle step (re-enqueueing a PR whose `pull_request` checks
   never ran because it was dirty) is the exact failure this section exists to
   prevent: the queue's entry requirement is "passed all required checks," and
   *absent* checks are not *passed* checks. The dry-run tracker (§7) flags this
   state explicitly ("dirty — no pull_request runs created while dirty").

### 3.2 Two queued PRs conflict with each other

The queue serializes entries onto the temporary branch in FIFO order, so a
semantic conflict between entry 1 and entry 2 surfaces as a red `merge_group`
run, not as a broken main. The failing entry is ejected (§2, ALLGREEN); the
other proceeds. The ejected lane rebases past the landed entry and re-enqueues
per §3.1.

### 3.3 The queue itself stalls

If `merge_group` checks stop reporting (CI outage, Actions incident), the
**status check timeout** (60 min, §6) ejects entries rather than letting them
rot. Lanes re-enqueue when CI is healthy. The timeout is sized above one full
CI cycle (the browser + cloudflare gates are the long pole).

## 4. Rollback procedure

The merge queue has **no automatic rollback of landed merges** — a bad merge
that passed green CI is still possible (flaky suite, semantic bug CI cannot
see). Exact steps:

1. **Revert on main.** A lane (any lane; this is incident response, not normal
   work) opens a revert PR:
   ```
   git fetch origin && git checkout -b jill/revert-<PR#>-<date> origin/main
   git revert -m 1 <merge-commit-sha>   # squash merges: -m 1 = mainline
   git push -u origin jill/revert-<PR#>-<date>
   gh pr create --title "Revert #<PR#>: <one-line reason>" --body "…"
   ```
   The revert PR goes through the normal path: exact-head green CI, then merge
   (via the queue if enabled — a revert is just another entry).
2. **If the bad merge was deployed** (room.trydemigod.com deploys track main):
   redeploy the last known-good SHA with `deploy-live.py` per
   `docs/ROOM-DEPLOYMENT.md`, then verify `/api/version`. The revert PR still
   lands afterward to keep history honest.
3. **Re-queue the work.** The original claim is re-opened (or a new claim
   filed) with a `failed(<code>)` → `working` transition on #266; the lane
   fixes forward and re-enqueues. The reverted PR number is referenced so the
   history is traceable.
4. **Notify.** The responding lane posts a `STATUS:` comment on #266 naming:
   the bad merge SHA, the revert PR, whether a redeploy happened, and the
   re-queued claim id. One comment, facts only. If the bad merge came from a
   specific lane's entry, that lane is @-mentioned in the same comment.

Rollback never bypasses CI: the revert PR is green-gated like any other entry.
Admin bypass (`--admin` / "bypass branch protections") is not used for
rollbacks — speed does not outrank the gate.

## 5. Interaction with the claims board (#266)

### 5.1 Who posts [done], and when

- **The lane, on MERGE — never on dequeue-from-queue.** The terminal receipt
  is posted when the PR actually merges into `main` and the merge SHA exists.
  Queue ejection (§3) is not a terminal event: the claim stays `working`, the
  lease keeps running, the lane rebases and re-enqueues.
- **Format (unchanged):** `[jill][done]` (lane tag as appropriate) +
  ```` ```room-done ```` block carrying `task-id`, `pr`, `sha` (the merge
  commit SHA on main). The receipt is the same one lanes post today; the only
  change is *who merges* (the queue, not the lane's button press).
- **Backstop:** the inert receipts workflow (§7) posts a machine `[lane]`
  receipt with PR + merge SHA if the lane hasn't within a grace window, so a
  merged claim can never go stale silently. Off by default; see §7.

### 5.2 What happens to the claim when a PR is dequeued

Nothing terminal. Mapping of queue events → claim state:

| Queue event | Claim state | Lane action |
|---|---|---|
| Enqueued (validating) | `working` (unchanged) | Wait; do not push |
| Ejected: CI red on merge_group | `working` | Fix, re-verify at head, re-enqueue |
| Ejected: dirty / conflict | `working` | Rebase per §3.1, re-verify, re-enqueue |
| Ejected: timeout | `working` | Re-enqueue when CI healthy |
| Ejected: lane removed it | `working` | Push fix, re-verify, re-enqueue |
| **Merged** | **`[done]` + `kb/plans/<task-id>.md`** | Post receipt with merge SHA |

A claim is closed by merge, by explicit `[done]`/`withdrawn`, or by lease
expiry — never by queue ejection alone.

### 5.3 Queue-state visibility for lanes

Three surfaces, in order of authority:

1. **GitHub's own UI/API** — the repo's Pull requests → "Merge queue" view
   shows live entries, order, and per-entry validation state. API:
   `GET /repos/Uuriko/project-room/merge-queues/main`.
2. **`scripts/merge-queue-dryrun.mjs`** (this PR, §7) — read-only tracker any
   lane runs before enqueueing: lists open PRs to main, their check state,
   mergeability, and the simulated FIFO order, flagging not-green and dirty
   entries. Dry-run only; it changes nothing.
3. **#266 receipts** — enqueue/eject/merge events are visible as lane
   `[receipt]`/`STATUS:` comments and the (opt-in) bot comments, so the board
   stays the journal of record even for queue-driven merges.

## 6. The one-click tap

**Who:** a repository admin — John. **When:** whenever he is ready; everything
below is pre-staged.

### 6.1 The click path (canonical)

1. Open `github.com/Uuriko/project-room` → **Settings** (rightmost tab, admin
   only) → **Branches** (left sidebar).
2. Under **Branch protection rules**, click **Edit** on the rule for `main`.
3. In the rule editor:
   - **Uncheck** "Require branches to be up to date before merging" (strict).
     The queue replaces this — §2.3. Do not leave both on.
   - **Check** "Require merge queue". The queue settings panel appears:
     - **Merge method:** Squash and merge (matches room practice; keeps one
       commit per PR on main).
     - **Build concurrency:** 2 (max parallel `merge_group` builds; bounds CI
       spend while keeping the queue moving).
     - **Only merge non-failing pull requests:** ON (ALLGREEN — §2).
     - **Minimum / maximum pull requests to merge:** 1 / 2 (§2, small groups).
     - **Wait time to meet minimum group size:** 5 minutes.
     - **Status check timeout:** 60 minutes (above one full CI cycle).
   - Confirm "Require status checks to pass before merging" still lists:
     `test`, `contract`, `lint`, `browser`, `cloudflare`.
4. **Save changes.** One save applies all of it atomically.

That is the whole tap. No second page, no follow-up PR.

### 6.2 Config-as-code alternative (one command, same effect)

The classic branch-protection REST API does **not** expose the merge-queue
toggle, so the scriptable path is a **repository ruleset** (`merge_queue` is
repository-level only — an org ruleset rejects it). Equivalent to §6.1,
runnable by John's session in one `gh` call:

```bash
gh api -X POST repos/Uuriko/project-room/rulesets --input - <<'JSON'
{
  "name": "main-merge-queue",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    {
      "type": "merge_queue",
      "parameters": {
        "merge_method": "SQUASH",
        "grouping_strategy": "ALLGREEN",
        "check_response_timeout_minutes": 60,
        "max_entries_to_build": 2,
        "max_entries_to_merge": 2,
        "min_entries_to_merge": 1,
        "min_entries_to_merge_wait_minutes": 5
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "test" },
          { "context": "contract" },
          { "context": "lint" },
          { "context": "browser" },
          { "context": "cloudflare" }
        ]
      }
    },
    { "type": "pull_request", "parameters": {} }
  ]
}
JSON
```

Caveats (why the UI path in §6.1 is canonical): the ruleset **composes with**
the existing legacy `main` protection rule rather than replacing it, and the
legacy rule currently has `strict: true` — so after creating the ruleset, the
legacy rule's "require branches to be up to date" must still be unchecked in
the UI (or the legacy rule deleted via
`gh api -X DELETE repos/Uuriko/project-room/branches/main/protection`). The UI
path in §6.1 does all of this in the single save, which is why it is the
recommended tap.

### 6.3 What happens automatically after the tap

1. The PR page gains a **"Merge when ready"** button (replacing "Merge pull
   request") on every green PR targeting `main`.
2. The first enqueue creates the queue; GitHub dispatches `merge_group`
   (`checks_requested`) events, and the `test.yml` readiness patch (§2.1) —
   already landed — runs the full suite on each prospective merge commit.
3. Lanes keep working exactly as today up to the merge step: claim → branch →
   PR → exact-head green CI → **enqueue instead of merge** → queue re-verifies
   → auto-merge → lane posts `[done]` with the merge SHA.
4. Post-merge `push` CI on main keeps running as the last line of defense.
5. Nothing else changes: no new permissions, no new secrets, no deploy impact,
   no claims-board protocol change (ejection ≠ done, §5.2).

### 6.4 Pre-tap checklist (all doable without John)

- [ ] This spec merged (BL-004 design).
- [ ] `merge_group` trigger patch on `.github/workflows/test.yml` landed
      (exact diff in §2.1; coordinate with RC-2026-09-26-965 which holds the
      file — do not collide).
- [ ] Dry-run tracker + receipts workflow merged (this PR, §7).
- [ ] Room briefed on #266: enqueue replaces the merge button; ejection is not
      done; jump-to-top is banned.

## 7. Bot prototype — what ships in this PR and why

Two files ship with this spec. Both are **fully inert without the tap**: they
do nothing to production, require no credentials beyond what the lane already
has, and were built and tested without any admin action.

### 7.1 `scripts/merge-queue-dryrun.mjs` — queue-state tracker (dry-run)

**What:** a read-only CLI any lane runs before enqueueing. It uses the `gh`
API (read-only GETs) to list open PRs targeting `main`, fetch each PR's
combined check state and `mergeable_state`, and print the simulated FIFO queue
order with flags: `READY` (green, mergeable — safe to enqueue), `NOT-GREEN`
(no green checks — cannot enqueue), `DIRTY` (conflicted — would be ejected;
notes the known platform behavior that no `pull_request` runs are created
while dirty, §3.1), `BEHIND` (mergeable but behind main — the queue will
re-verify anyway, informational only). Also reports whether the repo currently
has the queue enabled and whether `strict` is on (the §2.3 incompatibility).

**Why feasible without the tap:** it only reads public API state and simulates
locally — no queue, no writes, no admin. Tested against the live repo
(read-only) during development.

**Usage:** `node scripts/merge-queue-dryrun.mjs [--repo Uuriko/project-room]`

### 7.2 `.github/workflows/merge-queue-receipts.yml` — receipts backstop (inert)

**What:** a workflow triggered **only** by `merge_group` events
(`checks_requested`, `destroyed`). It posts short queue-status comments to
#266 (entry validating / entry ejected with reason / jump-to-top detected).
It is **doubly inert**: `merge_group` events do not exist until the queue is
enabled (§6), AND every job is gated on the repo variable
`MERGE_QUEUE_BOT == '1'` (Actions → Variables; unset by default). Until both
are true, the file is documentation.

**Why this shape:** §5.3 needs queue state visible on the board; the platform
only surfaces it in the GitHub UI. The workflow is the minimal bot that closes
that gap. It is deliberately narrow (status comments only — it never merges,
never dequeues, never touches code) and deliberately off by default: #266 is
near its comment capacity, so bot chatter stays opt-in until the room decides
otherwise.

### 7.3 Deliberately NOT included

- **No auto-merge bot / no custom queue implementation.** GitHub's native
  queue is the queue; reimplementing it would fork the source of truth.
- **No `merge_group` trigger on `test.yml` in this PR** — required before the
  tap (§2.1) but the file is claimed by RC-2026-09-26-965; the exact diff is
  specified here so any lane can apply it without collision.
- **No changes to branch protection, rulesets, or repo settings.** That is
  the tap, and it is John's.

## Appendix

- **Glossary.** *Entry*: one PR in the queue. *Merge group*: the set of
  entries validated together on one temporary branch. *Prospective merge
  commit*: the temp-branch HEAD the suite runs against. *Eject/dequeue*: the
  queue removing an entry (never a merge). *ALLGREEN*: grouping strategy where
  every entry must pass required checks.
- **Queue capacity note.** #266 is approaching GitHub's comment limit; the
  receipts workflow (§7.2) is variable-gated partly for this reason. Queue
  operations themselves do not consume #266 comments — only the opt-in bot
  does.
- **Verified against:** GitHub Docs "Managing a merge queue" (fetched
  2026-09-26), live `gh api` reads of `branches/main/protection` and
  `rulesets` (2026-09-26 — no rulesets, strict=true, queue off).
