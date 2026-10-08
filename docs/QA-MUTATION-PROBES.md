# QA Mutation Probes — claim-renew path

Living ledger for QA200 mutation-testing workers probing the work-claim
renew path (`server/work-claims.mjs`, `server/work-claim-routes.mjs`).
Append rows; never re-probe a row marked CAUGHT.

| Probe | Worker | Date (PDT) | Mutation | Existing tests catch? | Verdict |
|---|---|---|---|---|---|
| MUT-04-A | qa200-mut-04 | 2026-10-08 | renew w/o progressMessageId force-upgrades lease to 24h room default instead of keeping original duration | No — `tests/lease-renewal.test.js` pins the behavior ("the room's default 24h") | **UNCAUGHT — footgun LIVE**. Hardening test `tests/work-claim-renew-probes.test.js` MUT-04-A (kept `test.skip`; fails on current code). |
| MUT-04-B | qa200-mut-04 | 2026-10-08 | renew extends from now instead of old expiry (15-min lease renewed at +6min with 1h → now+1h, stealing ~9min) | No — `tests/lease-renewal.test.js` pins it ("starts a fresh lease window from now") | **UNCAUGHT — footgun LIVE**. Hardening test MUT-04-B (kept `test.skip`; fails on current code). |
| MUT-04-C | qa200-mut-04 | 2026-10-08 | allow renew of an indefinite (null-lease) claim | Yes — pure test "renewWork refuses a foreign owner, a non-active claim, a leaseless claim, and a lapsed lease" + route test "handler: renew of a leaseless claim is refused" both fail (422 `invalid_claim_input`) | **CAUGHT** |

## Notes

- Probe A/B footguns are **already the shipped behavior**, not seeded bugs:
  `renewWork` computes `leaseStartAt = now`, `leaseExpiresAt = now + (leaseHours ?? 24h)`.
  The hardening tests document the probe-semantics (playbook §4d) and are
  red-on-current by design; they are `test.skip`ped so CI stays green.
  Deciding the intended renew semantics (fresh window from now w/ default
  vs. keep original duration / extend from old expiry) is a design call for
  the coordinator — the tests here are the fail-first record, not the fix.
- Fail-first verification for MUT-04-A/B: probe tests fail on current code
  (red), pass under a probe-semantics patch (green-without), patch reverted.
- Probe C detail: removing only the null-lease guard does NOT create the
  footgun — the lapsed-lease check (`Date.parse(null) > now` → false) still
  blocks it, just with the wrong message. The faithful "allow it" mutation
  also skips the lapse check for null leases; then 2 existing tests fail.
- Skipped by brief: OAuth code reuse, spend void-after-settle,
  writer-fence tamper, permission-upgrade review().
