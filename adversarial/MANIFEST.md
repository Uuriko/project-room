# Adversarial/ops harness - passes 26-32

Additive-only test harness for the Project Room pilot, pinned to the Phase 0 public head
(`1d18471974243b3ffcd77c77124171f1351a4e25`, PR #8). No production-path changes.

## Environment

- Node v24.19.0 (`package.json` engines >= 24.19; `node:sqlite` required)
- `npm ci` once (playwright + an installed Chromium are needed only by `adv-hostile-check.mjs`; the other seven use node builtins only)

## Commands and verified results

Run from the repository root. Results below are from execution of these exact files at this commit.

| Pass | File | Command | Result |
|---|---|---|---|
| 26 return-brief endpoint | adversarial/adv-rb-check.mjs | `node adversarial/adv-rb-check.mjs` | 31 pass / 0 fail |
| 27 hostile ids/text | adversarial/adv-hostile-check.mjs | `node adversarial/adv-hostile-check.mjs` | 21 pass / 0 fail (includes isolated esc()-removal red/green; production `src/app.js` is never written). `MODE=mutant node adversarial/adv-hostile-check.mjs` serves only the isolated identity-`esc` copy and MUST exit non-zero |
| 28 events ceiling | adversarial/adv-caps-events.mjs | `node adversarial/adv-caps-events.mjs` | 4 pass / 0 fail (seeds 10,000 events, ~160s) |
| 28 member/work/credential/size caps | adversarial/adv-caps-rest.mjs | `node adversarial/adv-caps-rest.mjs` | 12 pass / 0 fail |
| 29 rate limits + stream caps | adversarial/adv-rate-check.mjs | `node adversarial/adv-rate-check.mjs` | 13 pass / 0 fail (includes a real 61s window-reset wait) |
| 30 CSRF/Origin/Host matrix | adversarial/adv-websec-check.mjs | `node adversarial/adv-websec-check.mjs` | 21 pass / 0 fail |
| 31 session cascade fuzz | adversarial/adv-cascade-check.mjs | `node adversarial/adv-cascade-check.mjs` | 29 pass / 0 fail (500 seeded ops, 146 tokens, model-matched sweeps) |
| 32 E2 restore drill | adversarial/adv-restore-check.mjs | `node adversarial/adv-restore-check.mjs` | 12 pass / 0 fail when the WAL stale-copy hazard is exhibited (`walExists && copiedSeq < liveSeq`). If that condition is not exhibited, D2 prints `INCONCLUSIVE` and does not count a stale-copy pass |

Total: 143 checks, 0 failures when the WAL hazard is exhibited (pass 27 is 21 rather than 17 because the isolated mutant proof is four real checks). Every check asserts a guard's exact boundary, so a regressed guard fails the suite. Pass 27 additionally proves that removing `esc()` in an isolated asset copy injects `img[src=x]` and stops rendering the hostile displayName as inert text; CSP still blocks the `__pwned*` inline handlers on both clean and mutant, so those flags are not the mutant signal.

## Documented not-tested

- The 2,000-distinct-rate-key global cap in server/http.mjs (closure-internal; reaching it honestly needs 2,000 distinct credentials).

## Drill finding folded into the D6 runbook

Pass 32 requires a .db-only file copy of the RUNNING service to be strictly stale while a WAL file is present (observed: live sequence 32 vs copy sequence 2). If the environment checkpoints the writes into the main file, the drill reports `INCONCLUSIVE` instead of claiming the hazard. Backup procedure lives in the D6 runbook r2 (dasha-desk #167, comment 5560292237): online backup API or VACUUM INTO hot, or quiesced checkpoint+copy; honest RPO = last verified backup.
