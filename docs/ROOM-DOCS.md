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
`rooms:*`. Reads do not initialize document tables. First write retains the
preview's existing lazy additive schema initialization; this is not a new
migration or a qualified hosted storage rollout.

Qualification: `node --test tests/room-docs.test.js tests/room-docs-http.test.js`.
The HTTP tests exercise real authentication, cross-room current/history
isolation, read-only API-key write denial, concurrent stale writes and 501-row
continuation. Current-main composition and hosted storage qualification remain
separate release requirements; no deployment is authorized by these tests.
