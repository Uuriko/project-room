# Room documents (flagged HTTP preview)

`ROOM_DOCS=1` enables room-scoped Markdown documents and revision history. The
flag defaults off. This is the HTTP foundation only: no UI, MCP document tools,
GitHub synchronization or search integration is implied.

- `GET /api/rooms/{roomId}/docs?limit=100&after=doc-id` returns metadata only:
  `docs`, `hasMore`, and `nextAfter` (null on the last page).
- `limit` is an integer from 1 to 500, default 100. Pass `nextAfter` as `after`
  until `hasMore` is false. Unknown and repeated query parameters are rejected.
- Ordering is ascending document id. `after` is a plain positional key, not a
  capability or authorization token. Every page authenticates room access.
- Traversal is live, not a frozen snapshot. Edits do not reorder documents;
  newly created ids at or before `after` require restarting the traversal.
  `hasMore: false` means no later ids existed at that read, not that the client
  possesses every document created during its traversal.
- `GET /api/rooms/{roomId}/docs/{docId}` reads the current document;
  `?rev=1` reads a historical revision with the same room access checks.
- `POST /api/rooms/{roomId}/docs/{docId}` takes `title`, `body`, `baseRev`.
  Use baseRev 0 to create, or the revision read to update. Stale writes return
  409 `doc_rev_conflict`; read again before deciding whether to retry.

All reads require current room membership. API keys additionally require
`rooms:read`, `rooms:write`, or `rooms:*`; writes require `rooms:write` or
`rooms:*`. The server option `roomDocsEnabled` defaults false; Node boot and the Worker
explicitly derive it from their own `ROOM_DOCS` environment. Reads do not initialize document tables. First write retains the
preview's existing lazy additive schema initialization; this is not a new
migration or a qualified hosted storage rollout.

Qualification: `node --test tests/room-docs.test.js tests/room-docs-http.test.js`.
The HTTP tests exercise real authentication, cross-room current/history
isolation, read-only API-key write denial, concurrent stale writes and 501-row
continuation. The composition is based on main 69149bcab. A real Workers fixture verifies
SQLite writes, paging, revisions and restart; the lazy-schema restore fixture
checks streamed document revision replay. Node tests cover full export/replay,
room purge and personal-room account deletion. These fixtures are not proof of
every production migration or backup configuration; no deployment is authorized.

Operational limits: leave the flag off until release review. With the flag off,
no document schema is created by reads. After documents are written, rolling
back to code without these tables' restore/purge registrations is not qualified:
retain a compatible reader/restore build and a verified backup. Disabling the
flag hides the API but does not delete documents. Existing maintainer wiki pages
and repository maps remain separate data/permission domains.

Ownership and retention: documents are room-owned shared records, not the
personal workspace of their latest author. Any active room member may edit;
there is no additional posting permission in this preview. API-key write scope
and current membership are rechecked after reading the request body. Archived
rooms permit reads but refuse creates/updates with `409 room_archived`.
Unlinking a member revokes their access, not other members' access to room records.
Personal-room account deletion and room purge erase document bodies/history.
In a retained shared room, author member ids and document/history text remain
room records; this patch does not redact mentions or offer per-author erasure.
The shared-record retention policy needs explicit product/privacy review before
enabling the feature; it must not be described as complete account erasure.
