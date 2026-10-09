# server/room-directory.mjs — public room directory

`RoomDirectory(store)` manages the public listing surface.

## Settings

`room_directory_settings(room_id PK, discoverable, listed_at, updated_at,
public_receipts INTEGER NOT NULL DEFAULT 1, opportunities_enabled, …)`.
- `set(roomId, memberId, boolean)` — **owner-only** (`_requireOwner`), upserts via
  `ON CONFLICT(room_id) DO UPDATE`. `listed_at` is set on first discovery and
  cleared when undiscovered. Runs inside `store.transaction`.
- `status(roomId, memberId)` → `{ roomId, discoverable, listedAt, publicReceipts }`.
- `public_receipts` defaults to **1 (public)** — mutation D5 (flipped to 0) survived;
  regression test added. An additive migration backfills the column on old DBs.

## Public listing

`list({ after, limit })`:
- Cursor pagination over `room_id ASC`; fetches `pageSize + 1` rows and emits
  `nextCursor` only when `rows.length > pageSize` — an exact page boundary emits
  **null** (mutation D1: `>=` emitted a phantom cursor; regression test added).
- Filters `discoverable = 1 AND archived_at IS NULL`.
- `_publicEntry` rebuilds a strict public view (title via `cleanText`, member
  count) — never the projection object; rooms whose state is unusable are
  silently skipped rather than 500ing the page.
- Limit is clamped to `DIRECTORY_PAGE_LIMIT`; bad cursors fail 422.

## Concurrency

100 racing `set()`s across 2 processes: exactly one row, coherent values
(`discoverable` ∈ {0,1}, `updated_at` > 0) — fuzz F11.

## Opportunity feed

Separate from discovery: `opportunityStatus` / feed toggles don't unlist the room
or change its work items. Existing discoverable rooms default to feed-on.

## Invariants

1. Only the owner can change directory settings.
2. Archived or undiscoverable rooms never appear in `list()`.
3. `nextCursor === null` ⟺ no further pages.
4. `public_receipts` defaults to public; the setting is per-room.
