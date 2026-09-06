# Adversarial/ops harness - passes 26-32

Additive-only test harness for the Project Room pilot, pinned to the Phase 0 public head
(`1d18471974243b3ffcd77c77124171f1351a4e25`, PR #8). No production-path changes.

## Environment

- Node v24.19.0 (`package.json` engines >= 24.19; `node:sqlite` required)
- `npm ci` once (playwright + an installed Chromium are needed only by `adv-hostile-check.mjs`; the other seven use node builtins only)

## Commands and verified results

Run from the repository root. Results below are from a clean-clone execution of these exact files at this commit (2026-09-06, ~08:39-08:42 PDT).

| Pass | File | Command | Result |
|---|---|---|---|
| 26 return-brief endpoint | adversarial/adv-rb-check.mjs | `node adversarial/adv-rb-check.mjs` | 31 pass / 0 fail |
| 27 hostile ids/text | adversarial/adv-hostile-check.mjs | `node adversarial/adv-hostile-check.mjs` | 17 pass / 0 fail (incl. esc()-removal mutation proof; restores the file) |
| 28 events ceiling | adversarial/adv-caps-events.mjs | `node adversarial/adv-caps-events.mjs` | 4 pass / 0 fail (seeds 10,000 events, ~160s) |
| 28 member/work/credential/size caps | adversarial/adv-caps-rest.mjs | `node adversarial/adv-caps-rest.mjs` | 12 pass / 0 fail |
| 29 rate limits + stream caps | adversarial/adv-rate-check.mjs | `node adversarial/adv-rate-check.mjs` | 13 pass / 0 fail (includes a real 61s window-reset wait) |
| 30 CSRF/Origin/Host matrix | adversarial/adv-websec-check.mjs | `node adversarial/adv-websec-check.mjs` | 21 pass / 0 fail |
| 31 session cascade fuzz | adversarial/adv-cascade-check.mjs | `node adversarial/adv-cascade-check.mjs` | 29 pass / 0 fail (500 seeded ops, 146 tokens, model-matched sweeps) |
| 32 E2 restore drill | adversarial/adv-restore-check.mjs | `node adversarial/adv-restore-check.mjs` | 12 pass / 0 fail |

Total: 139 checks, 0 failures. Every check asserts a guard's exact boundary, so a regressed guard fails the suite (inherent red-green sensitivity); pass 27 additionally carries an explicit mutation proof.

## Documented not-tested

- The 2,000-distinct-rate-key global cap in server/http.mjs (closure-internal; reaching it honestly needs 2,000 distinct credentials).

## Drill finding folded into the D6 runbook

Pass 32 demonstrates that a .db-only file copy of the RUNNING service is consistent but stale (live sequence 32 vs copy sequence 2; uncheckpointed pages live in -wal). Backup procedure lives in the D6 runbook r2 (dasha-desk #167, comment 5560292237): online backup API or VACUUM INTO hot, or quiesced checkpoint+copy; honest RPO = last verified backup.
