# Payload store (WAVE-300)

Content-addressed blob store for room payloads. Payloads up to 64 KiB keep
riding inline in event bodies exactly as today; anything larger is uploaded
once, addressed by its SHA-256, and events carry only the hash plus metadata.
Global scope gives free cross-room dedup. This slice is additive:
`room_attachments` (staged → committed) is untouched.

Status: **design doc** (docs-first). No implementation code in this slice.

## 1. Constants

```js
// Proposed home: server/payload-schema.mjs (mirrors attachment-schema.mjs
// owning the room_attachments table).
export const payloadLimits = Object.freeze({
  inlineBytes: 64 * 1024,            // PAYLOAD_INLINE_BYTES — see §6
  maxBlobBytes: 25 * 1024 * 1024,    // matches attachments.mjs DEFAULTS.maxFileBytes
  orphanLifetimeMs: 24 * 60 * 60 * 1000, // aligns with attachmentLimits.lifetimeMs (24h)
});
```

- **Inline threshold**: `payloadLimits.inlineBytes` (64 KiB). Payloads with
  `byte_length <= inlineBytes` stay inline in event bodies. Payloads larger
  MUST be uploaded and referenced by hash. The threshold is on decoded payload
  bytes, not base64 length.
- **Max blob size**: `payloadLimits.maxBlobBytes` (25 MiB), same cap as
  `validateAttachment`'s `DEFAULTS.maxFileBytes`. Anything larger is 413.
- **Orphan lifetime**: `payloadLimits.orphanLifetimeMs` (24 h), same window as
  staged attachment expiry. An uploaded-but-never-referenced blob becomes
  collectible after this (§7).

Why 64 KiB: it keeps `rooms.projection` (4 MiB cap, `PILOT_LIMITS.projectionBytes`
in `server/store.mjs`) and the 1 M-events/room budget healthy — a room of
all-inline events still holds tens of thousands of small payloads before the
projection cap bites, while anything that would meaningfully bloat projections
or event-row scans goes to the store.

## 2. Schema

```sql
CREATE TABLE IF NOT EXISTS payload_blobs (
  sha256      TEXT PRIMARY KEY CHECK(length(sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length<=26214400),
  media_type  TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  created_at  INTEGER NOT NULL  -- epoch ms, same clock as store.now()
);

-- Pin set for GC. A row here means "something durable names this hash".
CREATE TABLE IF NOT EXISTS payload_pins (
  sha256     TEXT NOT NULL REFERENCES payload_blobs(sha256),
  kind       TEXT NOT NULL CHECK(kind IN ('event','claim','attachment')),
  room_id    TEXT NOT NULL,
  ref_id     TEXT NOT NULL,   -- event id | claim id | attachment id
  created_at INTEGER NOT NULL,
  UNIQUE(sha256, kind, room_id, ref_id)
);
CREATE INDEX IF NOT EXISTS payload_pins_sha ON payload_pins(sha256);
```

- `payload_blobs.sha256` is lowercase hex, computed server-side over the
  decoded bytes (`createHash("sha256")`). Clients never supply the hash on
  upload — the server derives it, which makes dedup and integrity one step.
- No `room_id` on the blob: content addressing is global; one row serves every
  room that pins it.
- `media_type` is stored normalized lowercase at upload (same normalization as
  `checkedFile` in `server/room-attachment-bytes.mjs`).

## 3. BlobBackend interface (R2-ready)

```js
export class BlobBackend {
  async put(sha256, { bytes, mediaType, byteLength }) { throw new Error("unimplemented"); }
  async get(sha256) { /* -> { bytes, mediaType, byteLength } | null */ throw new Error("unimplemented"); }
  async del(sha256) { throw new Error("unimplemented"); }
  async exists(sha256) { throw new Error("unimplemented"); }
}

// This slice: LocalBlobBackend over the payload_blobs table (better-sqlite3,
// synchronous under the hood; keep the async surface so R2 drops in later).
export class LocalBlobBackend extends BlobBackend { /* ... */ }
```

- R2 comes later via env config only, e.g. `PAYLOAD_BACKEND=r2` plus the
  bucket/credential vars. **This slice does no network and stores no
  credentials.** The store class takes a `BlobBackend` in its constructor;
  the default is `LocalBlobBackend`.
- Backend switch must be atomic per process (read env once at boot, like other
  `boot-config.mjs` flags). Mixed backends within one process are out of scope.
- Builder note: 25 MiB BLOBs through better-sqlite3 are fine, but stream them
  as `Buffer`, never as base64 strings held twice in memory; the HTTP layer
  already bounds the request body (§5).

## 4. HTTP endpoints

Both live in `server/http.mjs` next to the room-files block (~line 3294) and
reuse its auth preamble verbatim: `roomCredentials(req, url)` →
`roomAuth(selected, roomId, fence)` → bearer/session gate → api-key scope check
→ `rate()` → handler.

Route literals MUST keep the `const x = /^...$/;` shape — the route-docs gate
only indexes that form:

```js
const roomPayloadsMatch = /^\/api\/rooms\/([^/]{1,384})\/payloads$/.exec(url.pathname);
const roomPayloadGetMatch = /^\/api\/rooms\/([^/]{1,384})\/payloads\/([^/]{1,64})$/.exec(url.pathname);
```

The sha segment allows `{1,64}` (the full lowercase-hex digest); anything not
matching `^[0-9a-f]{64}$` is 422 `invalid_payload_ref`. Well-formed but unknown
is 404 `payload_not_found` — same 404-not-403 posture as room files so hashes
don't leak existence beyond the capability.

### POST /api/rooms/{room}/payloads — upload

- Scope: api-key `rooms:write` (same scope rule as file stage; guest agents
  denied — mirror the `isGuestAgentMemberId` 403 from `RoomAttachmentBytes`).
- `protectWrite(req, auth, selected.bearer)`; `rate(\`write:${auth.credentialHash}\`, 60)`.
- Body: `body(req, { limit: payloadBodyBytes })` where
  `payloadBodyBytes = base64LengthForBytes(payloadLimits.maxBlobBytes) + 8192`
  (mirrors `mcpAttachmentBodyBytes`). Shape: exactly
  `{ mediaType, data }` (`exact(data, ["mediaType","data"])`), both strings,
  `data` canonical base64 with no whitespace (reuse
  `validAttachmentData`-style checks, generalized to the 25 MiB cap).
- Handler (`store.payloads.upload(token, roomId, { mediaType, data })`):
  1. Decode base64 (round-trip check); > maxBlobBytes → 413 `payload_too_large`.
  2. Security checks (§8); sha256 = hash(bytes).
  3. `INSERT OR IGNORE` into `payload_blobs` (backend `put`).
     Existing row → `{ duplicate: true }`, status 200. New row → 201.
- Response:
  ```json
  { "status": "stored", "duplicate": false, "roomId": "…",
    "payload": { "sha256": "…", "byte_length": 123456, "media_type": "image/png" } }
  ```
- Upload is idempotent: same bytes → same sha → `duplicate: true`. Upload alone
  creates NO pin; the blob is an orphan until referenced (§7).

### GET /api/rooms/{room}/payloads/{sha256} — download

- Scope: api-key `rooms:read`. `rate(\`read:${auth.credentialHash}\`, 600)`.
- GET and HEAD (HEAD mirrors the room-files `json(res, 200, obj, isHead)` pattern).
- The `{room}` segment is an auth anchor only: the caller must be a member of
  that room with read scope. The sha256 is a 256-bit capability — unguessable,
  so global dedup does not leak bytes across rooms in practice.
- Response:
  ```json
  { "roomId": "…",
    "payload": { "sha256": "…", "byte_length": 123456, "media_type": "image/png",
                 "encoding": "base64", "data": "…" } }
  ```

Error codes reuse the `reject(code, msg)` shape: `invalid_payload`
(422, bad shape/base64), `payload_too_large` (413), `blocked_media_type`
(422), `invalid_payload_ref` (422, malformed sha), `payload_not_found` (404),
`insufficient_scope` (403), `guest_scope_denied` (403).

`docs/openapi.yaml` gains both paths (the route-docs gate extracts the
literals from `http.mjs`; openapi entries are still hand-written).

## 5. Event-body convention

Events carry hashes and sizes, never bytes:

```json
{ "payload_ref": { "sha256": "…64-hex…", "byte_length": 123456, "media_type": "image/png" } }
```

Rules:

- `payload_ref` is an object with exactly `sha256`, `byte_length`, `media_type`.
- `sha256` matches `^[0-9a-f]{64}$`; `byte_length` is a non-negative integer
  equal to the stored blob's `byte_length` (resolvers SHOULD verify on read in
  debug/test builds; the store guarantees it at pin time).
- A `payload_ref` MUST NOT appear alongside inline `data` for the same
  payload — one or the other.
- Writers SHOULD upload (POST …/payloads) before posting the event, and SHOULD
  reuse the upload response's `payload` object verbatim as the ref value.

### Helpers (proposed home: `server/payload-refs.mjs`)

```js
isPayloadRef(value)            // shape check, no I/O
validatePayloadRef(value)      // throws ServiceError(422 invalid_payload_ref)
externalizePayload(store, memberCtx, { mediaType, data })
  // data: base64 string. If decoded bytes <= inlineBytes → returns { mediaType, data }
  // (inline, unchanged). Else uploads via the store and returns { payload_ref: {...} }.
resolvePayload(store, value)
  // { payload_ref } → { mediaType, bytes } via backend (404 payload_not_found
  // if the blob is gone); inline { mediaType, data } → decoded, passthrough.
pinPayloadRefs(db, refs, { kind, roomId, refId })
  // INSERT OR IGNORE into payload_pins. Called transactionally with the
  // write that introduces the reference (event append, claim write).
```

The event-append path (and any claim-file write path that accepts payload
hashes) scans the incoming body for `payload_ref` values and pins them in the
same transaction that commits the event — a ref is never visible before its
pin exists (§7 invariant).

## 6. Inline threshold, precisely

`payloadLimits.inlineBytes = 65536`. Enforcement points:

1. **Writers**: `externalizePayload` routes > 64 KiB to the store automatically.
2. **Server guard**: the event-append path rejects an event whose body embeds
   a single base64 `data` field decoding to more than 64 KiB with 413
   `payload_too_large` + a hint to use POST …/payloads. (Small inline payloads
   keep working exactly as today — full backward compat.)
3. The guard measures decoded bytes, and applies per embedded payload, not to
   total event size.

## 7. GC: pinned-set sweep (not refcount)

**Decision: mark-and-sweep over the pin set; refcount rejected.** Refcounts
decay: three reference kinds (events, claims, future attachments), concurrent
writers across rooms, and crash windows between "last ref removed" and
"counter decremented" make an exact counter unmaintainable. Pins are
monotonic — a pin is written once, transactionally with its reference, and
never needs decrementing — so the sweep only has to answer "is this hash
named anywhere durable?".

**What counts as a reference** (each is a `payload_pins` row):

| kind | Written when | ref_id |
|---|---|---|
| `event` | an event body containing `payload_ref` is appended | event id |
| `claim` | a work-claim file/artifact record names a payload sha | claim id |
| `attachment` | reserved: a future slice externalizes large `room_attachments` bytes into the store | attachment id |

(`room_attachments` rows are NOT references today — they keep their own bytes
per §9. The `attachment` pin kind exists so that future slice needs no GC
redesign.)

**Safety invariant.** GC deletes a blob row **iff**
`created_at <= now - orphanLifetimeMs` **and** no `payload_pins` row names its
`sha256`. Pins are written in the same transaction as the referencing write,
so a blob is pinned before any reader can resolve its ref; the 24 h grace
covers the upload→reference crash window (a crashed uploader's orphan ages out
harmlessly, and re-upload is idempotent). **GC therefore never deletes a
referenced blob.**

Collection: `collectPayloadGarbage(db, backend, { now, limit })` —
`DELETE FROM payload_blobs WHERE created_at <= ? AND sha256 NOT IN (SELECT
sha256 FROM payload_pins)` batched with `LIMIT`. Called opportunistically from
the upload path (cheap, bounded) and from a future scheduled sweep; both call
the same function. Backend `del` runs per deleted row so R2 stays consistent
later.

## 8. Security

Reuse the `validateAttachment` pipeline from `server/attachments.mjs` and the
media-type policy from `server/room-attachment-bytes.mjs`:

- `MEDIA_TYPE` regex (`type/subtype`, lowercase) — reject anything else (422).
- `BLOCKED_MEDIA_TYPES` set plus the `application/x-ms*` / `application/x-dos*`
  prefix blocks — reject (422 `blocked_media_type`).
- Filenames don't exist on this endpoint (body is `{mediaType, data}`), so the
  blocked-*extension* checks have no filename to run against; the MIME-type
  blocklist is the enforcement point. (If a `filename` field is added later,
  run the full `validateAttachment` filename policy including extension blocks.)
- Size: decoded bytes ≤ 25 MiB (413 above); base64 shape canonical, no
  whitespace.
- `checkedFile`-equivalent returns the normalized lowercase `media_type`
  stored on the blob row.
- Auth: `rooms:write` to upload, `rooms:read` to download; guest agents denied
  both (mirrors RC-2026-09-27-2716); same bearer/session gating and
  `protectWrite` as the room-files routes.
- SHA-256 of the stored bytes is recomputed on upload and verified against the
  row on download in test/debug builds; the digest is the primary key, so a
  corrupt row fails closed at lookup.

## 9. Backward compatibility

- `room_attachments` (stage/list/get/discard/commit) is untouched — same
  tables, same 1 MiB/file cap, same states.
- Event bodies ≤ 64 KiB inline payloads work exactly as today; no migration of
  existing events.
- The new store is purely additive: two tables, two routes, one backend
  interface. Nothing existing reads `payload_blobs`.
- Future (out of scope): externalizing large staged-attachment bytes into
  `payload_blobs` would use the `attachment` pin kind and keep the
  stage/commit API identical.

## 10. Builder notes

- New files: `server/payload-schema.mjs` (limits + DDL), `server/payload-store.mjs`
  (`PayloadStore` class: `upload`, `get`, pins, GC), `server/payload-refs.mjs`
  (convention helpers), `server/blob-backend.mjs` (`BlobBackend`,
  `LocalBlobBackend`). Wire `store.payloads` in `server/store.mjs` like
  `store.roomAttachments`.
- Keep every new route regex a `const x = /^...$/;` literal in `http.mjs` (the
  route-docs gate indexes that shape and nothing else).
- Tests: run with `TMPDIR=~/workspace/pr-wave300-payloads/.tmp` (never default
  `/tmp`); `npm run verify:affected` before pushing. New tests cover:
  upload idempotency (`duplicate: true`, 200 vs 201), 64 KiB boundary (65536
  inline / 65537 externalized), 25 MiB + 1 → 413, blocked MIME → 422,
  malformed sha → 422, unknown sha → 404, GC spares pinned blobs and collects
  aged orphans, pin written transactionally with event append.
- `docs/openapi.yaml`: add both paths; the route-docs gate checks the literals
  exist in `http.mjs`.

## 11. Open questions for the coordinator / builders

1. **Claim-file references**: work-claim `files` are repo-relative *paths*, not
   hashes. Which claim write path should accept/pin payload shas (artifact
   submissions? `public_work_finish`?), and does it need a schema change to
   carry the sha? The `claim` pin kind is designed but has no producer yet.
2. **Event-append guard scope**: should the >64 KiB inline rejection apply to
   *all* event types or only message-ish ones? All-types is simpler and
   fail-fast; per-type risks silent bloat.
3. **GC trigger**: opportunistic-on-upload only, or also a scheduled sweep
   (cron/worker tick)? Opportunistic is enough while volume is low; a
   scheduled sweep needs an owner.
4. **MCP surface**: do the MCP file tools (`room_stage_file` et al.) get
   payload siblings in this wave, or REST-only for now?
5. **GET response for huge blobs**: base64 JSON for a 25 MiB download is
   ~33 MiB of JSON. Acceptable for this slice, or should GET support
   `?format=raw` / content-type passthrough later?
6. **Cross-room pin lifetime**: pins are never deleted today (events are
   append-only). If event retention/pruning ever lands, GC needs a pin-prune
   hook — flag it in that design, not here.
7. **docs/INDEX.md**: should this doc be linked from the index now, or when
   the implementation slice lands?
