# Room export set — suspected bugs

WAVE-400 code archaeology, server core. Suspected, not fixed. Each entry is
`file:line — one-line reason`. Checked: the whole of all three modules plus the
callers (`server/http.mjs` export + attachment routes, `cloudflare/room.mjs`,
`server/store.mjs`), the cited cross-references (`scripts/backup-room.mjs`,
`server/public-work-claim-fence.mjs`, `docs/history/EXPORT-RETENTION-DELETION.md`,
the `:channel` copy convention), and the existing test suites
(`tests/room-backup-export.test.js`, `tests/rel14-backup-bytes.test.js`).

## Suspected

- `server/room-attachment-bytes.mjs:47` — `validAttachmentData("")` returns `true`
  (length 0 passes the `% 4` check and the regex is skipped), so `stage` silently
  accepts an empty payload and stores a 0-byte file; `checkedFile` allows
  `sizeBytes: 0`. Empty attachments are probably never intended — a minimum-size
  guard or explicit rejection looks missing.
- `server/room-export-html.mjs:137` — `MESSAGE_POSTED` keys the message by
  `data.messageId || event.id`; if both are absent the message lands under an
  `undefined` Map key, so multiple id-less messages collapse into one row and render
  with a broken id. Export rows should always carry an id, but the walk has no
  fallback/throw for the impossible case.
- `server/room-export-html.mjs:167-172` — `WORK_BLOCKER_RESOLVED` appends a note but
  never moves the work item back out of `state: "blocked"`; a room whose blocker was
  resolved renders the item as blocked forever, with no subsequent event type able to
  restore it. Suspected one-way state-machine gap (verify against the event
  semantics in `src/events.js` before treating as a bug).

## Checked and not flagged

- Path traversal: none by design — attachment bytes never touch the filesystem and
  `validateAttachment` rejects `/`, `\`, NUL in filenames.
- Content-type handling: `checkedFile` lowercases the MIME, enforces a strict
  `type/subtype` regex, and blocklists executables/scripts plus `application/x-ms*`
  / `application/x-dos*`; `safeEvidenceHref` admits only `https:` with no
  credentials. No bypass found.
- XSS in the HTML export: every event-sourced value passes through `esc()`/`attr()`;
  the single `href` is re-validated at render time; the document has no script or
  handlers and the CSP hash is computed from the exact style string served.
- Torn-backup handling: `exportTrailer`/`verifyTrailer` refuse mid-export writes
  loudly; hash is over sanitized cells so sanitize-rule changes can't false-positive.
- BLOB round-trip (REL-14): canonical-base64 check on export (`cellOf`) and on
  stage (`decodeData`), plus `byte_length`/`sha256` proof on replay (`checkStoredBytes`).
- Authorization: operator export uses `timingSafeEqual` and 404s when unconfigured;
  room file routes re-authenticate and re-check visibility per call; guest denial is
  explicit in stage/discard/commit (they bypass `store.command`'s gate).
- Memory: `exportNdjsonLines` materializes each table fully via `.all()` — a
  scaling gotcha for BLOB-heavy tables, not a correctness bug.
