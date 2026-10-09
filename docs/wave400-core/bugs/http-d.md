# server/http.mjs (lines 3751–5005) — suspected bugs

Checked: owner gates (export/import/delegations/directory/face), body() null
safety, query-param validation, NaN paths (`Number()` on query params),
DM-visibility stripping, idempotency statuses, rate limits, error-envelope
consistency, and the route-name ternary's final default. Most suspicions were
cleared on verification:

- `import` owner-only: enforced store-side (`server/store.mjs:4078` — 403
  owner_required). Not a bug.
- `body()` rejects empty/non-JSON/non-object bodies (400/415) before handlers run,
  so `data.memberId` dereferences in DELETE/SAVED and similar paths can't throw
  on null. Not a bug.
- NaN query values (`?limit=abc`, `?tail=abc`, `?after=abc`, return-brief
  horizon/after/cursor/limit) are all rejected fail-closed by store-layer
  validators (`Number.isSafeInteger` checks in `eventsAfter`, `readEventTail`,
  `resolveHistoryWindow`, `listActivity`). Not bugs.
- The member-card handler's `origin` at line 4444 is in scope — it's the
  `createRoomServer` parameter (line 301). Not a bug.
- The route ternary's final default `"ownership-transfer"` (3591) is unreachable
  for collab/work-claims/matchmaking/feedback/board-v2/bounty matches because
  those handler blocks return before the later `route ===` checks run. Not a bug.

## Open suspicions

1. `server/http.mjs:4379–4382` — the `needs-attention` 422 path answers with a
   hand-built `return json(res, 422, { error: "invalid_attention_query", message: … })`
   instead of `reject()`. Every other 422 in the funnel goes through `reject()`,
   which produces the standard envelope with `operationId` and `category`. This
   route's error body lacks both — an inconsistency, and any consumer keying on
   the envelope loses the operation id for this one path.

2. `server/http.mjs:4752–4754` — the `directory` POST reject message says
   "discoverable (boolean) is required; publicReceipts (boolean) is optional",
   but the validation directly above accepts `{ publicReceipts }` alone
   (`(!hasDiscoverable && !hasReceipts)` is the reject condition). The message
   misstates the accepted shape — a caller sending only `{publicReceipts}`
   would never trigger it, but anyone reading the message gets the wrong
   contract. Minor; the stale comment at 4746–4749 (openapi documents only
   `{discoverable}`, no longer true) is the same rot.
