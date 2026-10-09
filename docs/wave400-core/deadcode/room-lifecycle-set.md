# room-lifecycle-set — dead-code candidates (WAVE-400)

Grep evidence: every `.mjs`/`.js`/`.md` under the worktree (excluding node_modules), plus docs/ and tests/.

## Candidates

### 1. `server/room-lifecycle.mjs:24` — `ROOM_LIFECYCLE_MIGRATION`
- **Exported** (`export const ROOM_LIFECYCLE_MIGRATION = 28;`), with zero references anywhere else in the repo. The only hit for the symbol is its own declaration line; no import, no test, no doc mentions it.
- Evidence: `grep -rn "ROOM_LIFECYCLE_MIGRATION"` over the whole tree returns only `server/room-lifecycle.mjs:24`.
- Verdict: dead export. It is labeled "informational: which chain step introduced rooms.archived_at", so it may have been intended as documentation-in-code, but nothing consumes it. Removal is safe but changes the public export surface — a consumer outside this checkout could import it (unlikely).

## None others found

Every other exported symbol in the three files has live consumers:

- **room-lifecycle.mjs**: `migrateRoomLifecycleV28` ← `server/store.mjs:1455`; `verifyRoomLifecycle` ← `server/store.mjs:1302,1808,1879`; `refuseArchivedWrite` ← 7 files (`agent-invites`, `guest-invites`, `referral-invites`, `share-links`, `squads`, `store`, own file); `archivedAtOf` ← `server/store.mjs:2736,4110,4785`; `createAccountRoom` ← `server/store.mjs:3151` (wrapper), `server/http.mjs:2056,2085`, `server/templates.mjs:155`, `scripts/account-deletion-browser-check.mjs:25`; `ACCOUNT_ROOM_SELECT` + `accountRoomEntry` ← `server/store.mjs:49,3143`; `ACCOUNT_ROOM_LIMIT` used internally at line 133.
- **room-context.mjs**: `buildRoomContext` ← `server/store.mjs:4238`; `contextVersion` used internally by `buildRoomContext`; `ROOM_CONTEXT_OMITTED` ← `tests/room-context.test.js` and echoed in every context response.
- **room-guide.mjs**: `installGuideCommandHook` ← `cloudflare/room.mjs:100`, `server/starter-room.mjs:65`; `flushRoomGuide` ← `cloudflare/room.mjs:193`; `runGuideStep` ← `server/starter-room.mjs:115`, `tests/starter-room.test.js:189`; `ROOM_GUIDE_ID` ← re-exported and used by `starter-room.mjs`/`receipt-cards.mjs`; `STARTER_CLAIM_ID` ← `starter-room.mjs` (4 refs); `WELCOME_BODY` used internally at line 120 (not dead — a consumer-facing string constant for the welcome post).
