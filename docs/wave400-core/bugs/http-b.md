# Suspected bugs — server/http.mjs lines 1251–2500

## none found

Checked and cleared:

- `?limit=abc` on `/receipts` (http.mjs:1901): `Number("abc")` → NaN, but
  `queryPublicReceipts` in server/public-read-model.mjs:585 validates
  `Number.isInteger(limit) && 1 <= limit <= 50` → 422 `invalid_receipt_query`.
- `?limit=abc` on `/api/public-work/tasks` (http.mjs:1791):
  server/public-work-claims.mjs:105 `check(Number.isInteger(limit) && 1 <= limit
  <= 100 ...)` rejects with 'Invalid page'.
- Anonymous `GET /api/public-work/receipts/:id/review` (http.mjs:1741):
  `bearer(req)` returns null, but
  server/public-work-reviews.mjs `contributorReview` resolves the secret and
  401s on unknown/null identity.
- `/api/guest-agent-links/{preview,join,refresh}` (http.mjs:2427,2435,2447):
  only `exact(data, ["linkToken"])` is checked, no `typeof` string check —
  but `GuestAgentLinks.preview/join/refresh` all call
  `assertGuestAgentToken(linkToken)` first, which throws on non-string/invalid.
- `POST /oauth/authorize` (http.mjs:1442): request re-validated before the
  decision is acted on; the consent POST CSRF compares with `timingSafeEqual`
  against the session token; invalid `redirect_uri` → 400 JSON, never an open
  redirect.
- GitHub callback state/code dedupe (http.mjs:1318): repeated `state`/`code`
  params throw `github_callback_invalid` → 422.
- `/oauth/token` refresh-reuse: handled inside the provider (family revocation
  + invalid_grant), consistent with the consent-screen promise.

## Follow-ups for another lane (not bugs, need store-level eyes)

- `POST /api/public-work/match` passes a possibly-null bearer secret straight
  to `store.publicWorkClaims.match` — intended anonymous matching, but worth
  one store-level test to confirm null-secret semantics are deliberate there
  (the review route next to it 401s on null, so the two sibling endpoints
  treat null differently by design — just confirm).
