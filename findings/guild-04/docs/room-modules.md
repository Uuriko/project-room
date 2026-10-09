# server/room-assistant.mjs, room-attachment-bytes.mjs, room-flood-guard.mjs, room-key-presence.mjs

## room-assistant.mjs — shared-work coordination runs

`RoomAssistant(store)`; tables `room_assistant_config`, `room_assistant_runs`,
`room_assistant_ops` (idempotency by `(room_id, actor_id, request_id)`).

- `apply(roomId, input, authorize)` — actions: configure / request / act / …
  Strict input-shape validation (unknown keys → 422 `invalid_assistant_action`).
  **Guests are denied** (`assistant_denied`, 403 — mutation R4 survived, untested).
  Archived rooms refuse (`assistant_archived`).
- **Lost-update protection**: `configure` requires `input.expectedRevision ===
  config.revision` (mutation R1 verified — killed).
- **Retry idempotency**: same `requestId` + same canonical input → replays the
  stored response; same `requestId` + different input → 409
  `assistant_retry_conflict`.
- **Terminal-state guard**: actions on `done`/`cancelled`/`failed` runs fail
  `assistant_run_closed` (mutation R5 survived, untested).
- **Input cap**: 100 inputs per run (`assistant_input_limit`; mutation R2:
  101 allowed — untested). **Activity ring buffer**: `run.activity.slice(-100)`
  (mutation R3: unbounded growth — untested).
- `list()` — reads never mutate storage (fresh installs return defaults);
  run visibility follows `messageVisibleToViewer`; stale hosts
  (>120s without `hostReportedAt`) surface as `unknown`.

## room-attachment-bytes.mjs — staged file bytes

`RoomAttachmentBytes(store)`; table `room_attachments` with states
`staged → committed/expired/discarded`; bytes stored inline as BLOB.

- `stage()` — authenticates directly (bypasses `store.command`, so the guest
  denial is enforced explicitly: 403 `guest_scope_denied` — mutation A2 survived,
  untested). Quotas enforced per room / per member / staged-count / record-count
  (409 `attachment_quota`); per-file cap `attachmentLimits.fileBytes` → 413
  `attachment_too_large` (mutation A1 survived, untested).
- `checkedFile` blocks executable types (`BLOCKED_MEDIA_TYPES`; mutation A4
  survived, untested).
- `discard()` — optimistic concurrency: `changed !== 1` → 409
  `attachment_conflict` (mutation A3 inverted it — untested).
- `expire()` — `expires_at <= now` → staged rows become `expired`, bytes nulled
  (mutation A5: `<=`→`<` — untested).
- **Visibility** (#983): a staged file is visible only to its uploader; a file
  committed onto a DM is visible only to the DM parties.
- Hostile ids / payloads: `validAttachmentData` returns boolean-only verdicts;
  15 hostile inputs rejected-as-422 or accepted-clean (fuzz F10).

## room-flood-guard.mjs — token-bucket rate limiting

`createRoomFloodGuard({ now, capacity = 30, refillPerSecond = 0.5 })`.
- `decision.allowed` gates sends; allowed senders are never limited
  (mutation F1 verified — killed).
- `Retry-After` is floored at 1s (`Math.max(1, …)`; mutation F2: floor 0 —
  untested).
- Empty/invalid room or member ids are ignored, never bucketed together
  (mutation F3 verified — killed).
- Burst behavior under test: 30 allowed / 70 denied per burst, `Retry-After=2s`,
  non-chat commands spend nothing, bucket refills after 60s, garbage ids ignored
  without throw (fuzz F9).

## room-key-presence.mjs — room-key heartbeat auth

- `roomKeyPresenceAuth(store, secret)` — the credential must be a room-scoped
  access credential held by an agent member (mutation K1: inverted check —
  killed).
- **Single-room linkage**: the identity must be linked to exactly one room, and
  it must be this room (`rooms.length !== 1 || …` — mutation K2 weakened to
  `< 1`, letting multi-room identities pass; untested).
- `assertRoomKeyPullOnly` — pull-only identities may not set wake URLs
  (mutation K3 verified — killed).
- `roomKeyHostId` — hostId must match `/^[A-Za-z0-9._-]{1,128}$/` (mutation K4:
  129 — untested); the host hash is truncated to 48 hex chars (mutation K5:
  47 — untested). 6 valid / 15 hostile ids behave correctly (fuzz F10).
