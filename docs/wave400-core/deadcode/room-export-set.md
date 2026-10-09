# Room export set — dead-code candidates

WAVE-400 code archaeology, server core. Method: every exported symbol of the three
modules was grepped across `server/`, `src/`, `scripts/`, `cloudflare/`, and `tests/`.

**none found.**

Evidence per module:

- `server/room-export.mjs`: every export has a production caller or a test caller.
  `exportNdjsonStream` + `operatorExportResponse` → `cloudflare/room.mjs`;
  `replayNdjson` → `scripts/replay-room-export.mjs`, `scripts/restore-room-backup.mjs`;
  `exportNdjsonText`, `exportNdjsonLines`, `sanitizeCell`, `verifyTrailer`,
  `REPLAY_SKIPPED_TABLES` → `tests/room-backup-export.test.js` /
  `tests/rel14-backup-bytes.test.js`. `authorizeOperatorExport` is exercised via
  `operatorExportResponse`. No export is unreferenced.
- `server/room-export-html.mjs`: `renderRoomExportHtml` + `EXPORT_HTML_CSP` →
  `server/http.mjs` (export route, `?format=html`). `walkExport`, `safeEvidenceHref`,
  `esc`, and `EXPORT_HTML_DOCUMENT_CSP` are used internally by the module itself and
  exported for reuse/tests — reachable, not dead. Internal helpers (`attr`, `when`,
  `renderEvidence`, `STYLE`, `STYLE_HASH`) are all referenced.
- `server/room-attachment-bytes.mjs`: `RoomAttachmentBytes` → `server/store.mjs`
  (as `store.roomAttachments`); `mcpAttachmentBodyBytes` → `server/http.mjs` and
  `server/routes/code-drops.mjs`; `validAttachmentData` →
  `server/inbox-attachment-bytes.mjs` and `server/mcp-room-profile.mjs`;
  `base64LengthForBytes` → `server/mcp-hosted-tools.mjs`. Internal helpers
  (`fail`, `decodeData`, `checkedFile`, `view`, `BLOCKED_MEDIA_TYPES`, `MEDIA_TYPE`)
  are all referenced.

Near-misses that were checked and are NOT dead:
- `esc` in room-export-html.mjs looks like it could be shadowed by client-side copies
  (there are identically-named `esc` helpers in `src/*.js`), but the module export is
  genuinely importable and the internal module uses it everywhere.
- `exportNdjsonText` has no *production* caller (production uses the stream or the
  generator), but it is the primary helper in both backup test suites — test-support,
  not dead.
