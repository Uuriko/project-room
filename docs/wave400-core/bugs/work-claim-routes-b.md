# Suspected bugs — work-claim-routes.mjs lines 681–1355

Checked: all 17 route branches, the transaction/housekeeping prologue
(689–797), the 405 fallback, the MCP entry points that live just above the
range (546–580, read for context), and the throw-vs-reject error plumbing.

- `server/work-claim-routes.mjs:1036` — the `update` route rejects with
  403 unless `item.owner === caller`, so a manage_claims holder or the room
  owner cannot update someone else's claim — while `release` (1160),
  `reassign` (1183) and `close`/`cancel` (1149) all admit those same actors
  via `authorityOver`. Asymmetric; if managers are meant to steer others'
  work, updates are the gap; if intentional, it is undocumented.
- `server/work-claim-routes.mjs:742` — `sweepRoom` runs unconditionally before
  route dispatch, so the `receipts` search (811) and single-claim `read` (966)
  perform lease-expiry writes and emit `lease_expired` room events on read-only
  requests. Same housekeeping, but a read path that mutates is a footgun for
  callers assuming idempotent GETs.
- `server/work-claim-routes.mjs:799-807` — `GET /status` and `GET /` (list)
  call `closeLiveClaims`, which commits `state_changed` events for land/deploy
  claims as a side effect of a GET.
- `server/work-claim-routes.mjs:1352-1353` — the 405 fallback passes
  `{ Allow: allowedMethod }` as a 4th `reject()` argument; unverified that the
  helpers' `reject` forwards it as an actual `Allow` response header, which the
  RFC 9110 comment (1342) promises.
- `server/work-claim-routes.mjs:1183-1206` — `reassign` validates the new
  owner's membership and slot cap, but unlike `create`-with-`assignee` (927)
  and `claim` (971) it does not validate `dependsOn`/PR-input fields against
  the item — not a bug per se, but the route mutates ownership without
  re-running the input validators the other acquire paths use.
