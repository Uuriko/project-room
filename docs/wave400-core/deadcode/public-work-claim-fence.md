# Dead code candidates: public-work-claim-fence.mjs (WAVE-400)

## Verdict: none found

All three exports are referenced from live code paths (verified by grep over
`server/`, `cloudflare/`, `scripts/` at origin/main c5d1c313a):

- `publicWorkClaimFenceSchema` — `server/store.mjs:1057` (schema install list), `server/store.mjs:1679`
  (`this.db.exec(...)`).
- `verifyPublicWorkClaimFence` — `server/store.mjs:2` (import), `1275`, `1677`, `1681` (boot/migrate
  verification); `cloudflare/public-work-claims.check.mjs:18,41` (scenario `validFence` check).
- `withPublicWorkClaimWriter` — `server/public-work-claims.mjs:5` (import), `122` (`enable()`), `152`
  (`act()`), `238` (`apply()` auto-claim path); `cloudflare/public-work-claims.check.mjs:18,45`
  (fixture fault injection).

Internals: `permit`, `permitSql`, `protectedNamespace`, `definitions`, `normalize` are all used in
building the schema string or `verifyPublicWorkClaimFence`. The six trigger definitions
(`public_claim_guard_work_claims_{insert,update,delete}`,
`public_claim_guard_work_claim_config_{insert,update,delete}`) are asserted in
`tests/work-claim-schema.test.js` and `tests/public-work-claim-fence.test.js`.

The permit table/trigger names are also referenced by `server/room-export.mjs` (replay permit
open/close), `server/operator-purge.mjs` (purge permit open/close), `server/writer-fence.mjs`
(unfenced-additive registration), and `scripts/runtime-package.mjs` (optional browser package).
