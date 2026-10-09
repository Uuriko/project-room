# room-directory-set — suspected bugs (WAVE-400 code archaeology)

NOT fixed — documentation only. What was checked: every public API of the three
modules; every read path that could expose a room or its receipts to a viewer
who shouldn't see them; auth checks on all mutators; cursor/idempotency edge
cases. Line numbers from the `wave400/docs-core` snapshot.

## 1. Public room page leaks receipt titles after owner turns public receipts off

server/public-rooms.mjs:78–82 (call site) ← server/public-read-model.mjs:657
(`roomPageReceipts`).

`publicRoomView` fetches the room's receipt list via `roomPageReceipts` imported
**directly from the raw read model**, bypassing the `server/receipts-live.mjs`
wrapper whose `hiddenReceiptIds` filter removes receipts belonging to rooms with
`public_receipts = 0`. The receipt feed (`queryPublicReceipts`), the detail page
(`publicReceiptById`), the sitemap, and the public-work receipt endpoints all go
through that wrapper and correctly 404/hide — only the room's own `/r/{slug}`
page was missed. Result: after an owner flips the toggle, receipt **titles**
(and links that then 404) remain publicly listed on the room page. This directly
contradicts the module's own header promise ("the public receipts feed hide the
room's receipts from non-members" — the room page was forgotten).

## 2. Idempotency replay can 409 on a mutable displayName

server/agent-rooms.mjs:165–172 (`create()` duplicate short-circuit).

The `same` comparison that decides "this is a replay of my own create" includes
`state.members[memberId]?.displayName === displayName`. `displayName` is mutable
(member updates can change it). If the identity's display name changed between the
original create and a retried request with the same roomId (e.g. a dropped response
being retried), the retry no longer matches `same` and gets 409 `room_exists`
instead of the idempotent `duplicate: true` payload. The ownerId/title/purpose/kind
comparisons are stable; displayName is the weak field.

## 3. Re-listing after unlist loses the original listedAt

server/room-directory.mjs:111–116 (`set()`).

Unlisting writes `listed_at = NULL`, so a later re-list reads `existing.listed_at`
as null and falls back to the current time. Consumers of `listedAt`
(`_publicEntry`, directory API, sitemap consumers) see a fresh first-listed date
rather than the room's original listing date. Only unlist-then-relist paths are
affected; plain re-lists preserve it as documented.

## 4. Read-model snapshots lag the receipts-visibility toggle

server/room-directory.mjs:136–151, 172–189 (`setOpportunities`, `setReceiptsVisibility`).

Unlike `set()`, these two upserts never call `refreshListedRoom`. Anything cached
in the read model (feed rows, the room page's receipt list) can keep reflecting
the old setting until the next unrelated refresh. Per-read gates (http.mjs:1772,
public-work-claims.mjs:290) still enforce visibility at serve time, so this is a
staleness window, not a standing leak — except where bug 1 removes the gate.

## Checked, not filed

- `AgentRooms.list()` includes archived rooms (no `archived_at IS NULL` filter unlike
  `RoomDirectory.list()`): not a leak — these are the caller's own linked rooms.
- `RoomDirectory.list()` cursor lacks `validId` validation: harmless, only used in a
  string `>` comparison.
- `transfer()` maps reducer "Unknown member" to 404: message-match on the reducer's
  wording, but behavior is correct as written.
- `/r/{slug}` join links exposing the owner-issued join token in the URL fragment:
  intended for `link`-mode rooms (join-by-link).
- `publicReceiptsVisible()` defaults to `true` for unknown rooms / pre-migration rows:
  matches the documented "preserving current behavior" default.
