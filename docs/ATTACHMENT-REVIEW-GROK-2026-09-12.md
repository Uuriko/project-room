# Attachment readiness review (Grok, G4)

12 September 2026. Canonical checkout only. **Read-only.** No upload implementation. No deploy.

Codex assignment: review room attachment readiness against isolated `/Users/johnpotter/src/project-room-integration` (HEAD `6f2b175` when this review started) and current canonical HTTP. Codex owns implementation in the isolated tree, including the later storage-qualification claim.

This document is **gap evidence**, not readiness. Passing absence tests does not mean files can be uploaded.

## Current evidence (not invented)

**No room file upload/download routes.**

- Canonical `server/http.mjs:479` room subpaths are exactly:
  `commands|events|stream|cursor|return-brief|work-context|work-discussion|work-result|work-sessions|charter|reply-requests|reply-context|reply-history|invitations|share-links|share-links-cancel|reminders|agent-connections|guest-agent-links|diagnostics`
- Integration `server/http.mjs:499` adds presence, capabilities, onboarding-funnel, export, import, diagnostics-export, search, provider-heartbeats, identity-links, agent-invites. Still **no** `attachments`, `files`, `uploads`, or blob path.
- Unmatched `/api/rooms/:id/attachments` is 404 **before** auth on both trees.

**SQLite has no blob table.**

- Canonical `server/writer-fence.mjs`: `STORE_SCHEMA_VERSION = 26`. `applicationTables` is rooms/events/commands/accounts/credentials/invitations/cursors/checkpoints plus share links, reminders, agent connections, private inbox/email. No `files` / `blobs` / `attachments`.
- Integration fence is schema **27** (`agent_identities`, `identity_links`, additive `agent_invite_codes`). Still no file/blob table.
- A live `RoomStore` `sqlite_master` listing matches that inventory; absence tests below query it.

**Email “attachments” are descriptors, not files.** Same on both trees:

- `src/inbox-ui.js:161-162` renders counts then **“files unavailable”**.
- `src/inbox-client.js:74` rejects any reply envelope where `p.attachments.length` is truthy.
- `src/inbox-client.js:39` treats a draft as supported only when `attachmentCount === 0`.
- Graph/import fixtures store Microsoft Graph `fileAttachment` metadata; they do not persist bytes.

**Export `Content-Disposition: attachment`** in integration `server/http.mjs:619` and `:676` is JSONL/JSON history download, not user file sharing.

**Worker constraint:** Durable Object SQLite + `cpu_ms` 50. Canonical and integration `cloudflare/wrangler.jsonc` have **no** `r2_buckets` / blob binding. Node runtime is the same SQLite file, not object storage.

Audit B6 already recorded missing file/image attachment. This review does not claim that finding closed.

## Reconciliation with Codex contract

Compared to isolated `docs/ATTACHMENT-BUILD-CONTRACT-2026-09-12.md` at `6f2b175`.

### Agree (same facts)

- Status is **not implemented**. Email descriptors and export Content-Disposition must not be reused as room file sharing.
- Unversioned side table or local-filesystem-only upload would bypass writer-fence, recovery table inventory, and Node/Worker parity.
- Possession of a URL is never sufficient; download must recheck current room authorization.
- No raw bytes in the event log, search index, public discovery, or diagnostics.
- Tests that prove missing routes are **gap evidence**, not a product.

### Adopt Codex’s journey as the required contract

My first draft listed a five-step upload/message/download/revoke/delete sketch. Codex’s contract is the one to implement against. In particular I under-specified:

1. Composer: name/size/Remove; upload progress distinct from send; cancel before send never publishes; preserve text on upload failure.
2. Send one message with **immutable file references**. Lost-response retry repeats the original operation, not a second file or message. Do not show an upload in history until the message transaction accepts the references.
3. Names are escaped text, not HTML or filesystem paths.
4. Leaving, removal, key rotation, and session expiry follow the same rules as room reads. Bytes already downloaded **cannot be recalled**; say so rather than promising revocation.
5. Delete needs a durable audit tombstone and an unavailable state in history. Deleting live bytes is not erasing backups.
6. Authenticate upload **before** reading the body; bound bytes while reading even without Content-Length; revalidate at commit.
7. Download: `no-store`, `nosniff`, `Content-Disposition: attachment` with a safely encoded filename. Initially download, not active-content preview. Declared MIME is not malware safety.
8. Do not add an empty Files destination before browsing/reuse needs it.
9. Any schema addition must update migration, Node/Worker old-writer fencing, recovery inventory, integrity verification, and runtime packaging **together**. Do not copy the additive `agent_invite_codes` exception without proving file deletion/quota/replay/recovery.
10. 1 MiB per-file is a **proposed pilot cap**, not a measured Node or Worker maximum.

Storage sequence A→B→C→D in the Codex contract is correct: qualify byte storage on Node SQLite and the existing local Durable Object test runtime **before** a schema change. I do not claim a storage choice. Codex now owns that experiment (`cloudflare/attachment-storage.*`) and the follow-on staging module (`server/attachments.mjs`); this review stays off those files.

### Storage primitive evidence at `7bccb18` (reconcile, still not ready)

Read-only against `docs/ATTACHMENT-STORAGE-QUALIFICATION-2026-09-12.md`. Codex measured Node SQLite and Miniflare 4.20260730.0: 2/2, exact SHA-256 for 0–1 MiB, restart, rollback, duplicate-ID conflict, logical delete. Native primitives only — not RoomStore, not auth, not quota, not recovery, not HTTP.

I agree with Codex’s decision line: a **bounded in-database pilot is plausible** without provisioning R2. I do **not** agree that this closes the journey. Remaining before any public capability:

- Shared adapter + migration fences + recovery inventory together
- Per-file/room/member quotas and bounded body reads (auth before body)
- Staged ownership, immutable message references, audited tombstones
- Authenticated HTTP + composer; MCP stays `ship:false` with no upload tool

Logical deletion is not secure erasure of disk pages or backups. Empty-file support is a storage observation, not product policy. Do not extrapolate 1 MiB to production Worker `cpu_ms` 50 or concurrent uploads. Canonical HTTP/store still have **no** file tables or routes (absence tests below).

### Additional constraints this review adds (not contradictions)

- Public MCP preview stays `ship:false`. Do **not** add upload tools, multipart `/mcp`, or persisted `oa1.` join in order to share files.
- Canonical MCP sources remain frozen unless Codex assigns an edit.
- Cross-room reference must fail even if the caller has a valid credential for a different room.
- Unauthenticated 404-vs-401 on `/files/:id` must not leak object existence; prefer the same unauthenticated shape as other missing room routes (canonical unmatched paths are 404 before auth).
- HTML/SVG/script as `image/*` or `text/html` must never be served for inline browsing in v1.
- Staged-upload expiry and concurrent quotas are required before any hosted rollout.

### Not ready

Nothing in either tree satisfies Codex’s “done” line: the upload-to-download-and-delete journey is not integrated or qualified. Hosted rollout and external services still need owner authorization. I do not recommend implementing on canonical or on the public MCP preview.

## Adversarial tests (this review)

`tests/attachment-absence-http.test.js` drives shipped `createRoomServer` and `RoomStore`:

- `GET/POST/PUT/DELETE` `/api/rooms/commons/attachments|files|files/x`, `/api/uploads`, `/api/files` → 404
- `POST /mcp` `multipart/form-data` → 415 `json_required`
- Live `sqlite_master` has no `files`/`blobs`/`attachments` table
- Shipped `applicationTables` contains none of those names
- `GET /api/open` and `/.well-known/mcp.json` do not advertise attach/upload/blob; public `tools/list` names omit attach/upload/file/blob

Passing those tests means **absence**, not a working upload product.

Codex’s remaining adversarial list (Content-Length lies, CSRF, MIME mismatch, retry CAS, Node/Worker parity, composer a11y) belongs to the implementation lane after storage qualification. I did not invent those as passing tests.

## Recommendation

Keep room file sharing off public MCP and off canonical until Codex finishes isolated storage qualification, then schema+fence+recovery together, then the authenticated journey in the isolated integration tree. Email attachment descriptors stay metadata-only. I will not implement bytes, R2, or schema here.
