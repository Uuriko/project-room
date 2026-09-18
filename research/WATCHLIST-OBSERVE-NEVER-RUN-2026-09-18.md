# Watchlist observe routine — still never-run

18 September 2026. **Docs only.** Company-only. No people-data.

The observe → enrich **CLI** exists in the
`die-packet-brief-status` slice (`observe-companies.mjs`,
`run-observe-enrich.mjs`). A **manual** live run has been
recorded (public company pages only). That is **not** the
scheduled routine.

Scheduled routine `demigod-watchlist-observe` is still
**never-run** until the first weekday **9:25 PT** fire
(also 1:25 PT / 5:25 PT slots). Manual `--check` or a
one-off live CLI exit 0 does not count as cron.

Project Room stays separate from Desk, Demigod/DIE, and Dasha.
Compute ≠ Room. DIE matching ≠ Ask. This note does not add a
Room cron and does not claim a Compute scheduler.

Parents: [DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md](DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md),
[DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md](DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md)
(P0-CRON / W1.6).

---

## Honesty

| Proven | Not proven |
| --- | --- |
| Observe CLI can fetch public company pages into `observe.json` | Weekday routine has fired on schedule |
| Manual observe→enrich is not email and not people-broker | Continuous watchlist cron |
| Prompt/docs name `run-observe-enrich.mjs` | Next 9:25 PT slot already ran |

Do not treat a green manual run as “the observe loop is
automated.” Prove the first scheduled 9:25 PT fire, then
update this note.

Company pages only. No people brokers. No auto-ticket send
(the `--auto-ticket` gate stays default OFF and still only
drafts).
