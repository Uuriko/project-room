# Room export set — module docs

WAVE-400 code archaeology, server core. Covers `server/room-export.mjs` (326 lines),
`server/room-export-html.mjs` (274 lines), `server/room-attachment-bytes.mjs` (273 lines).

---

## server/room-export.mjs

**Purpose.** Whole-database NDJSON export and restore for the room store. The Durable
Object can't hand out its sqlite file (the on-disk server just copies it via
`scripts/backup-room.mjs`), so this module streams every table as sanitized NDJSON and
can replay that NDJSON into a fresh sqlite file, with an end-of-stream trailer that
lets replay refuse a backup torn by a mid-export write.

**Public API**
- `sanitizeCell(column, value)` — per-cell export sanitizer. Secret-named columns
  (`secret|token|password|verifier|private_seed|encrypted|refresh|p256dh`, plus `auth`)
  become sha256 hex; already-hashed columns (`hash`, `*_hash`) pass through;
  `auth_epoch` stays a number; BLOB values (Uint8Array/ArrayBuffer/SharedArrayBuffer/views)
  become `{$base64: ...}`; token-shaped strings (`pri_|rak_|ga1.` + 8+ chars) get
  sha256-scrubbed. REL-14 fix: bare BLOBs used to export as `{}`/`{"0":..}` and produced
  unrestorable backups.
- `exportNdjsonLines(db)` — generator yielding one JSON line per row: a `watermark`
  line (version, room id/sequence list, event count), then `{table, row}` lines in a
  fixed order (`accounts, rooms, events, …` first, then alphabetical), then a trailer
  line. `credentials` is ordered parent-first so `parent_hash` replays.
- `exportNdjsonText(db)` / `exportNdjsonStream(db)` — whole text, or a
  `ReadableStream` of UTF-8 chunks (still materializes each table fully via `.all()`
  between chunks).
- `exportTrailer(db)` / `verifyTrailer(trailer, byTable)` — trailer re-reads the event
  log after the last table and hashes `(room_id, sequence, id)` of the sanitized rows;
  verify throws on count or hash mismatch (a mid-export write = "torn backup, re-take it").
- `authorizeOperatorExport(authorization, expected)` — bearer check with
  `timingSafeEqual`; returns `"ok"` / `"denied"` / `"unconfigured"` (expected token
  missing or < 16 chars).
- `operatorExportResponse(request, token, db)` — serves `GET /api/operator/export`:
  404 when unconfigured, 405 for non-GET/HEAD, 401 when denied, 503 without a db;
  HEAD answers with headers only.
- `replayNdjson(ndjson, filename, {audit})` — parses the export (refuses malformed
  lines, double watermarks/trailers, non-canonical BLOB base64, tampered BLOBs via
  `byte_length`/`sha256` checks in `checkStoredBytes`), writes rows into a new sqlite
  file (mode 0600, dir 0700; refuses to overwrite an existing store), skips
  `REPLAY_SKIPPED_TABLES`, opens/closes the claim-writer permit around the bulk load,
  then runs foreign-key check, `quick_check`, event-count-vs-watermark check, and
  `auditRecovery` + `verifyInvitationAudit`. `audit:"strict"` throws on audit failure;
  `"report"` returns the failure as data.
- `REPLAY_SKIPPED_TABLES` — tables replay drops with reported row counts:
  `room_runtime_version`, `room_writer_permit` (Durable Object writer fence),
  `emissary_*` + `external_identities` + `external_receipts` (retired Emissary),
  `abuse_rate_buckets` (rate-limit state restarts fresh).

**Export formats produced.** NDJSON: `{kind:"watermark",version:1,…}` line,
`{table,row}` lines, `{kind:"trailer",version:1,…}` line. Not JSONL-per-event here —
this is the whole-database backup. Replay inverts it into a sqlite file. (The
per-room `{sequence, event}` JSONL download is built in `server/http.mjs` from
`store.exportEvents`, not in this module.)

**How attachments are resolved/served.** No filenames or paths involved: file bytes
live in the `room_attachments` table as BLOB columns, and the export carries them as
`{$base64: …}` cells on the row. Replay decodes them back to Buffers, proves them
against the row's `byte_length` and `sha256`, and binds them into the fresh sqlite
file. There is no separate blob store, so there is nothing to re-link.

**Invariants.**
- Secrets never leave the building in cleartext: whole secret columns hash; embedded
  token shapes inside prose get scrubbed; already-hashed columns are left alone so
  replay preserves identity bindings.
- The trailer is hashed over *sanitized* cells, exactly as yielded, so a future
  sanitize rule can't cause a false mismatch.
- Export table order puts FK parents first; replay inserts in the same parent-first
  order, with `PRAGMA foreign_keys=OFF` during load and a `foreign_key_check`
  afterwards.
- A torn export is refused loudly, never replayed quietly.

**Top callers.** `cloudflare/room.mjs` (operator export route:
`exportNdjsonStream` + `operatorExportResponse`); `scripts/replay-room-export.mjs` and
`scripts/restore-room-backup.mjs` (`replayNdjson`); `tests/room-backup-export.test.js`
and `tests/rel14-backup-bytes.test.js` (the whole surface).

**Gotchas.**
- Streaming is chunked per line but each table is fully materialized with `.all()`
  first — a room table with gigabytes of attachment BLOBs is one big allocation, not
  a true streaming dump.
- `verifyTrailer` sorts event tuples by `(room_id, sequence)` with string comparison
  on `room_id` and numeric on `sequence`, matching the trailer's `ORDER BY`; equal
  tuples are hash-identical, so ties are safe.
- The operator route returns 404 (not 403) when no token is configured, so the
  route's existence doesn't leak.
- Replay validates table *and column* names against the store schema (`quoteIdent`
  requires `^[a-z_][a-z0-9_]*$`) — an export from a newer schema with new columns is
  refused rather than silently dropped.

**Stale comments.** None found. Verified: `scripts/backup-room.mjs` exists;
`server/public-work-claim-fence.mjs` exists and its permit table name matches
`CLAIM_PERMIT_TABLE`; the `:channel` message-copy convention referenced by
`walkExport` is real (`server/message-redaction.mjs`, `server/history-visibility.mjs`);
`docs/history/EXPORT-RETENTION-DELETION.md` exists as cited.

---

## server/room-export-html.mjs

**Purpose.** Renders the per-room `{sequence, event}` JSONL export (from
`store.exportEvents`, owner-only via the `export` route in `server/http.mjs`) as one
self-contained HTML document a departing member can open or hand to someone else. It
is a *view over the event log, not the projection*: a deliberately small walk that
keeps only members, messages, work items and evidence links, and never fails on an
unknown event type (counted, ignored).

**Public API**
- `walkExport(rows)` — one pass over `{sequence, event}` rows; returns
  `{room, members, messages, work, count, first, last, lastAt, name}` where `name`
  resolves member ids to display names. Applies the deletion visibility rule:
  tombstoned/redacted messages render as "deleted" with no body and no edit history.
- `renderRoomExportHtml(rows, {roomId, generatedAt})` — full document string:
  header with room meta, members list, messages list (reply/edited flags, work-item
  links), work-item sections (definition of done, accountable, evidence, notes),
  and a footer "End of export: N events rendered, through sequence M" so a reader
  can tell a whole file from a truncated one.
- `safeEvidenceHref(value)` — returns the URL only if it parses as `https:` with no
  username/password; anything else (javascript:, data:, relative, junk) renders as
  plain text, never a link.
- `esc(value)` — HTML escape for element content and attributes (only two ways text
  reaches the document).
- `EXPORT_HTML_DOCUMENT_CSP` — `default-src 'none'; style-src 'sha256-<hash>';
  base-uri 'none'; form-action 'none'`, with the hash pinned to the module's single
  fixed `<style>` block; also embedded as a `<meta>` so a saved file keeps the policy.
- `EXPORT_HTML_CSP` — the document policy plus `frame-ancestors 'none'; sandbox`
  for the HTTP header.

**Export formats produced.** One self-contained HTML file: no script, no inline
event handlers, no style attributes, no external loads. No separate JSON — the
machine-readable copy is the per-room JSONL the route already serves.

**How attachments are resolved/served.** Not handled here — room files don't appear
in this document. Evidence links are `https:` URLs in work events, rendered as
`<a href rel="noopener noreferrer nofollow">` only after `safeEvidenceHref` passes.

**Invariants.**
- Every event-sourced value goes through `esc()` for content and `attr()` (same
  function) for attributes; the evidence `href` is the only attribute carrying
  user-controlled data and is re-validated at render time (the renderer doesn't trust
  the ingress validation).
- Deleted stays deleted: body cleared, edit flag cleared, no history rendered.
- The document is a reading, not a replay: unknown event types never throw.
- A work event with an unusable `workItemId` updates a throwaway record rather than
  inventing an "undefined" item.

**Top callers.** `server/http.mjs` only (the `export` route, `?format=html`: materialize,
render, audit, `Content-Length` + CSP headers + `attachment` disposition). `esc` is
also exported for reuse; no other production caller was found.

**Gotchas.**
- The work-item state machine is one-way for blockers: `WORK_BLOCKED` sets
  `state:"blocked"`, and `WORK_BLOCKER_RESOLVED` only appends a note — there is no
  transition back, so a resolved item can render as blocked forever (see bugs doc).
- Timestamps go through `when()`, which falls back to escaped raw text on invalid
  dates rather than throwing.
- The `sandbox` CSP token on a top-level document makes the browser treat it as a
  sandboxed browsing context — the "opens inline, runs nothing" posture is load-
  bearing on that header being sent; a file saved and opened still keeps the
  `<meta>`-embedded policy.

**Stale comments.** None found. Verified: `docs/history/EXPORT-RETENTION-DELETION.md`
exists; the `src/events.js` https evidence-URL rule the comment cites exists
(`src/events.js` ~1771–1790); the route comment about `Content-Length` framing
matches the actual route code.

---

## server/room-attachment-bytes.mjs

**Purpose.** The store API for the `room_attachments` table (owned by
`server/attachment-schema.mjs`, which holds the schema, byte caps, and the
staged/committed/discarded/expired/deleted states): stage, list, download, discard,
and commit files. Commit binds a staged file to an already-posted chat message; it
doesn't create a second blob store and doesn't post a message. Bytes stay in sqlite
as BLOBs — there is deliberately no filesystem path anywhere in this flow.

**Public API**
- `class RoomAttachmentBytes` (instantiated as `store.roomAttachments` in
  `server/store.mjs`), all methods run inside `store.transaction` and authenticate
  directly via `store.authenticate`:
  - `stage(token, roomId, {id, filename, mediaType, data})` — validates id, runs
    autonomy-tier + explicit guest denial (`room_put_file`), expires old staged rows,
    canonical-base64-decodes the payload, validates filename/media/size
    (`validateAttachment` + extension blocklist + executable-MIME blocklist), enforces
    room/member/staged-count/record quotas, inserts a `staged` row with sha256 and
    `expires_at = now + lifetimeMs`. Identical re-stage of the same id returns
    `{status:"staged", duplicate:true}`; any other id collision is 409.
  - `list(token, roomId)` — staged+committed rows, newest first, filtered by the
    visibility rule, as descriptor objects (no bytes).
  - `get(token, roomId, id)` — returns descriptor + `encoding:"base64"` + base64
    data. Invisible files 404 (not 403) so the id doesn't leak existence;
    expired/discarded/deleted rows 410.
  - `discard(token, roomId, id)` — uploader or room owner only; `staged → discarded`
    with `bytes=NULL` via a conditional UPDATE (409 if the row changed underneath).
  - `commit(token, roomId, {id, messageId})` — uploader-only; requires the message to
    exist, be undeleted, and be authored by the caller; same id+messageId is
    `duplicate:true`, a different message on an already-committed file is 409.
    Conditional `UPDATE … WHERE state='staged' AND uploader_id=? AND message_id IS NULL`.
  - `visibleTo(row, messages, memberId)` — staged → uploader only; committed onto a
    DM (`toMemberId`) → author and recipient only; everything else room-wide.
- `validAttachmentData(value)` — canonical base64, no whitespace, within size cap.
- `base64LengthForBytes(byteLength)` / `mcpAttachmentBodyBytes` — body-size budgets
  for MCP transports (max file + ~8 KB envelope).

**Export formats produced.** None — this is the live serving path, not the export
path. (Bulk export goes through `server/room-export.mjs`, which base64-encodes the
same BLOB cells into the NDJSON backup.)

**How attachments are resolved/served.**
- Upload: client sends base64 in the stage call; the server re-checks canonicality
  by round-trip (`Buffer.from(v,"base64").toString("base64") === v`), checks
  `bytes.length` against `attachmentLimits.fileBytes`, validates filename
  (1–255 chars, no `/`, `\`, NUL; trailing-dot/space aware extension extraction) and
  MIME (`MEDIA_TYPE` regex; hard block on executables/scripts plus `application/x-ms*`
  and `application/x-dos*` prefixes), then stores the BLOB in sqlite with sha256.
- Download: `get()` re-reads the row, re-checks expiry and visibility, and returns
  the bytes re-encoded as base64 in JSON. No filesystem, no temp files, no
  Content-Disposition — and therefore no path-traversal surface: filenames never
  touch a path.
- Lifecycle: staged rows expire (`state='expired'`, `bytes=NULL`) on the next
  `expire(roomId, now)` sweep (run at the top of stage/list/get/discard/commit);
  discard and expiry both NULL the bytes while keeping the row as a tombstone.

**Invariants.**
- `stage`/`discard`/`commit` authenticate directly and bypass `store.command`, so the
  guest scope gate is enforced explicitly in each mutating method (mirrors
  RC-2026-09-27-2716 / PR #1156).
- Autonomy tiers are enforced on stage/discard/commit (`room_put_file`,
  `room_discard_file`, `room_commit_file`).
- All mutations are compare-and-set style (`WHERE state=…`) and re-read the row
  before returning, so concurrent discards/commits surface as 409, not silent
  overwrites.
- `discard`'s owner check reads `this.store.room(roomId).state.room.ownerId` from the
  live projection.

**Top callers.** `server/store.mjs` (constructs `roomAttachments`);
`server/http.mjs` (the attachment routes: stage/list/get/commit at ~3322–3342, and
`mcpAttachmentBodyBytes`); `server/inbox-attachment-bytes.mjs` and
`server/mcp-room-profile.mjs` (reuse `validAttachmentData`);
`server/mcp-hosted-tools.mjs` (reuses `base64LengthForBytes`);
`server/routes/code-drops.mjs` (reuses `mcpAttachmentBodyBytes`).

**Gotchas.**
- Path traversal: none by design — bytes never leave sqlite, and `validateAttachment`
  rejects path separators in filenames. Content-type handling: `checkedFile`
  lowercases the MIME and tests it against a strict `type/subtype` regex plus the
  executable blocklist; callers sending the bytes back must re-derive the content
  type from the stored `media_type` (this module returns it in `view()` but `get()`
  serves JSON, not a raw download response).
- Quotas are room + per-member + staged-per-member + records-per-room, all checked
  in one aggregate query before insert.
- `list()` filters by visibility in JS after the DB query, and `get()` builds the
  message index from the live projection per call — a room with many messages pays
  that projection cost on every download.

**Stale comments.** None found. Verified: `server/attachment-schema.mjs`,
`server/attachments.mjs`, `server/autonomy-tiers.mjs`, and `server/guest-agent-links.mjs`
all exist as cited; `server/inbox-attachment-bytes.mjs` exists (the header's
"inbox_attachment_bytes" cross-reference is accurate).
