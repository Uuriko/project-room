# Dead-code candidates — server/http.mjs lines 1251–2500

Scope: only symbols defined (or small consts introduced) inside this range,
checked for callers/importers with `grep` across `server/` and `scripts/`.

## Definitely dead

none found.

## Probably dead / needs owner confirm

none found — everything defined in this range is referenced:

- `requireAccountSession` (line ~2231): used by all account-management,
  recovery-code, login-method, link/start, profile, onboarding, and deletion
  routes below it.
- `providerConfigured` (~2240): used by `GET /api/auth/methods`.
- `methodIdFrom` (~2252): used by the disable/enable/remove method routes.
- `githubHtml` / `githubLanding` (~1305/~1312): both used in the GitHub
  callback's HTML branch.
- `sendPage` (~1980): used by all four GR2 acquisition branches.
- `sessionMeta` (~1546): used by both `exchangeCode` and `refresh` calls.
- All route-literal blocks in the range are reachable handler code, not
  exported functions, so nothing else can be "imported" or orphaned from
  outside.
