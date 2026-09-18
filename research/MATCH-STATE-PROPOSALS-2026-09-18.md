# MATCH_STATES proposals (Wave 3 · W3.3 / P2-SOR)

18 September 2026. **Docs only.** Company-only. No people-data.

**Goal:** Let the local `die-packet-brief-status` draft factory
**propose** DIE `MATCH_STATES` transitions with evidence cites —
**never** silently mutate live DIE SoR.

DIE matching SoR lives in `demigod-ops/` (matching engine, match
review). This slice writes **proposals on disk** only. An operator
desk may list them; a human advances SoR.

Project Room stays separate from Desk, Demigod/DIE, and Dasha.
Compute ≠ Room. DIE matching ≠ Ask.

Parents: [DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md](DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md),
[DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md](DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md)
(W3.3).

---

## Mapping (local stage → DIE `MATCH_STATES`)

Sequence: `submitted → reviewed → matched → introduced → piloted → receipted → invoiced → paid`.

| Local stage | DIE `MATCH_STATES` | Role-packet stage |
| --- | --- | --- |
| observe / packet | _(pre-match)_ | — |
| brief | `submitted` | `brief_ready` |
| queue | `reviewed` | `reviewing` |
| consent | `matched` | `mutual_pending` |
| intro | `introduced` | `intro` |
| trial | `piloted` | → `outcome` |
| invoice | `receipted` → `invoiced` → `paid` | `outcome` |

---

## Artifact (proposed only)

`companies/<slug>/match-state-proposal.json` — ticketed companies
only (must already have `ticket-draft.json`). Shape:

- `schema`: `demigod.match-state-proposal/1`
- `status`: stays **`proposed`** until a human accepts or rejects
  **outside** silent automation
- `from` / `to`: DIE states
- `evidence[]`: cites existing packet / firmographics / ticket
  artifacts only — no invented hire
- `dieSoRMutation`: **always `false`** in this slice
- `policy`: local proposal only — operator/review advances SoR

Harness (slice, not Room): `propose-match-state.mjs`
(`--check` / `--dry-run` / `--apply`). `--check` validates
shapes and does not write. `--apply` writes the JSON on disk.

Operator desk may list `status=proposed` rows. Accept buttons
stay **inert** — accepting a proposal does **not** call
`demigod-ops` from this slice.

---

## Stay-outs

- No live DIE `MATCH_STATES` / role-packet mutation
- No kill-switch unblocks / no email / no Stripe / no people-data
- No invent hire; proposals cite existing company artifacts only

## Honesty

Green `--check` / desk listing ≠ SoR advanced. Hosted review +
human still own match state. `dieSoRMutation: false`.
