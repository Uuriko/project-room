# wave1000 guild-04 — dead-code analysis (with reachability evidence)

Method: for each exported symbol in the slice, `grep -rl` across
`server client src tests scripts bridge cloudflare` (*.mjs/*.js, node_modules
excluded); a symbol is dead only if it has zero references outside its defining
file AND zero internal uses.

## Result: no confirmed dead code in the slice

Every exported symbol checked has at least one consumer:

| Symbol | Defining file | Consumers |
|---|---|---|
| `RoomStore` | store.mjs | pervasive |
| `createDurableWorkClaimRegistry`, `workClaimSchema` | work-claim-sqlite.mjs | store, routes, tests |
| `buildRoomContext`, `contextVersion`, `ROOM_CONTEXT_OMITTED` | room-context.mjs | http/routes, tests (3 files) |
| `buildActivationPack` | room-activation-pack.mjs | 5 files |
| `RoomAssistant` | room-assistant.mjs | store wiring |
| `RoomAttachmentBytes`, `validAttachmentData`, `base64LengthForBytes`, `mcpAttachmentBodyBytes` | room-attachment-bytes.mjs | mcp inbox, http (2–4 files) |
| `createRoomFloodGuard` | room-flood-guard.mjs | 3 files |
| `installGuideCommandHook`, `runGuideStep`, `flushRoomGuide`, `WELCOME_BODY`, `ROOM_GUIDE_ID`, `STARTER_CLAIM_ID` | room-guide.mjs | `flushRoomGuide` used by cloudflare/room.mjs:193; `WELCOME_BODY` used internally (line 120) |
| `roomKeyPresenceAuth`, `assertRoomKeyPullOnly`, `roomKeyHostId`, `roomKeyPresenceView` | room-key-presence.mjs | heartbeat routes |
| `RoomDirectory` | room-directory.mjs | routes |
| `verifyRoomLifecycle`, `migrateRoomLifecycleV28`, `refuseArchivedWrite`, `archivedAtOf`, … | room-lifecycle.mjs | store.mjs |
| `exportNdjsonText`, `replayNdjson`, `REPLAY_SKIPPED_TABLES` | room-export.mjs | 2–7 files |
| `renderRoomExportHtml`, `safeEvidenceHref`, `esc` | room-export-html.mjs | 4 files |

## Review candidate (not confirmed dead)

- `walkExport` (server/room-export-html.mjs): exported, but the only in-repo
  consumer is `renderRoomExportHtml` in the same file (plus guild-04's fuzz).
  It is a coherent public seam (rows → walked model) — kept deliberately, not
  removed. Flagging for the owning lane, not deleting.

## Slice-boundary note

The slice lists `server/event*.mjs`, but **no file matches that prefix** — event
types live in `src/events.js` and the event log in `server/store.mjs`
(`events` table). `server/work-claim-events.mjs` exists but is outside the
`event*` prefix pattern; it was not touched.
