# work-claim-sqlite.mjs — dead-code scan

Source: `server/work-claim-sqlite.mjs` at origin/main c5d1c313a.
Method: grepped all exports and registry methods across `server/`, `cloudflare/`,
and `tests/` (excluding `node_modules`).

## Definitely dead

**None found.** Every export and every registry method has at least one caller:

- `createDurableWorkClaimRegistry` — `server/store.mjs:1197`, `cloudflare/public-work-claims.check.mjs:53`, plus 6 test files.
- `workClaimSchema` — `server/store.mjs:1048,1512`, plus 4 test files.
- `WORK_CLAIM_ROW_KIND` — `tests/persisted-row.test.js:135` (asserts the stored envelope tag).
- `transaction` — `server/claim-autolink.mjs:270,369,407`, `server/claim-pr-sync.mjs:452,516,551`, `cloudflare/store-worker.test-fixture.mjs:143`.
- `verifySchema` — `server/store.mjs:1271,1511,1513`.
- `get` / `set` / `list` / `has` / `delete` — dozens of call sites (land-queue, claim-pr-sync,
  claim-autolink, public-work-claims, routes, mcp profiles, templates, agent-rooms, etc.).
- `configure` — `server/mcp-full-profile.mjs:288` (production), plus tests.
- `configFor` — `server/land-queue.mjs:485`, `server/work-claim-mirror.mjs:50,68` (production),
  plus tests/fixtures.
- `rawConfig` — `server/work-claim-mirror.mjs:30` and `:755` of `work-claim-routes.mjs`
  (via duck-typing `typeof registry.rawConfig === "function"`), plus internal use in `configure`.

## Probably dead / needs owner confirm

**None found.** The smallest-audience method is `rawConfig`, but it is live in
`work-claim-mirror.mjs` (the mirror falls back to it when the in-memory registry lacks it)
and `work-claim-routes.mjs:755` builds `roomWorkClaimConfig` from it for the default-registry
path — both real production paths.

## Notes

- The per-call `db.prepare` in the `statement()` helper looks wasteful but is intentional
  (lazy prepare; see module doc). Not dead, not removable without a refactor of the
  construct-before-migrate ordering in `store.mjs`.
- Internal helpers `decodeItem`, `parse`, `WORK_CLAIM_FIELDS`, `WORK_CLAIM_DEFAULTS` are all
  referenced by the read/write paths. `parse` is used only by `rawConfig`; `rawConfig` is
  live, so `parse` is live.
