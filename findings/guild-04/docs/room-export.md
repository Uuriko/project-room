# server/room-export.mjs + server/room-export-html.mjs — export & replay

## NDJSON export (`exportNdjsonText(db)`)

Line-delimited JSON: one `watermark` line, one line per table row
(`{ table, row }`), one `trailer` line (`{ kind: "trailer", version: 1, events,
eventsHash }` where `eventsHash` is the sha256 of the event stream).
- BLOB cells are encoded as `{ "$base64": "<canonical base64>" }`; replay
  rejects non-canonical base64 (mutation E2 was a TIMEOUT-HANG — under re-test).
- `quoteIdent` validates every table/column name against `IDENT` before it is
  interpolated into SQL — replay refuses exports naming tables the store will
  not write (mutation E4 under re-test).
- 5000 events stream at ~11MB without heap growth (fuzz F8: streamed 5007 lines /
  11.4MB, heap delta −6.2MB; trailer verifies over the full stream).

## Replay (`replayNdjson(ndjson, filename, { audit })`)

1. `parseExport` fails fast on: empty input, non-JSON lines, duplicate watermarks,
   duplicate trailers, malformed trailers, non-table rows, missing watermark.
2. `verifyTrailer` — torn exports (event count ≠ trailer count) are refused
   *before any store is created* ("a mid-stream write the watermark could not see
   must never verify").
3. Every cell passes `cellOf`: objects that are not `{ $base64: <canonical> }`
   throw `"Export cell is an object that is not an encoded BLOB"` (fuzz F12).
4. `checkStoredBytes` — a row's `bytes` must match its `byte_length` and `sha256`
   (mutation E3 under re-test).
5. Unknown tables → throw; `REPLAY_SKIPPED_TABLES` (Durable-Object-only tables)
   are skipped and reported, not replayed.
6. After load: `foreign_key_check`, `quick_check`, event count vs watermark,
   then `auditRecovery` + `verifyInvitationAudit` — `audit: "strict"` (default)
   throws on audit failure; `"report"` returns it in `audit: { ok: false }`
   (disaster restores need the data back and the drift named, not a refusal).
7. Refuses to replay into an existing file; the restored file is chmod 600.

Fuzz F12 hostile replays: empty / not-JSON / two watermarks / two trailers /
bad trailer hash / torn count / object cell / noncanonical base64 / unknown table /
missing watermark — every one throws clean and bounded (<15s); a valid export
replays `verified: true`.

## HTML export (`renderRoomExportHtml`)

- Every interpolated value passes through `esc()` (text) or `attr()` (attributes);
  `attr === esc` in the current code.
- `safeEvidenceHref` links **only** credential-free `https:` URLs; `javascript:`,
  `data:`, `http:`, and credentialed URLs render as inert `<code>` text, never
  links (fuzz F13).
- Deleted messages render as "Message deleted" tombstones — bodies are nulled
  before render (mutation H3 under re-test).
- Unknown/future event types are ignored, never throw (fuzz F13).
- The document carries a CSP meta tag (`EXPORT_HTML_DOCUMENT_CSP`; mutation H5
  under re-test).

## Gotcha

`walkExport` and `renderRoomExportHtml` take *rows* (`{ sequence, event }`), not a
store — callers must shape the input; `exportNdjsonText` takes the raw db.
