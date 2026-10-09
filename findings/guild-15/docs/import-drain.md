# Channel import + drain

Sources: `server/channel-import.mjs`, `server/channel-drain.mjs`.

## `prepareChannelFixturePage` — the pure import path

Fixture synchronization with **no credentials, fetch, sockets, or send API**.
Prepare and apply stay separate so a lost acknowledgement can be retried with
the exact operation; a new prepare rehydrates, never rebases old content.

1. Snapshot `store.email.state(...)`; `guard()` re-checks before/after every
   adapter call: import permission, fixture mode, unchanged connection digest,
   unchanged folder revision — any drift → 409 (`email_connection_changed`,
   `stale_email_page`).
2. Adapter contract required: `changes` + `hydrate` + `normalize` functions,
   boolean `reset`.
3. Adapter/channel/provider scope must match the connection
   (`channel_recording_scope_changed`).
4. Page ≤ 50 messages (`pageMessages`); each change hydrated and normalized;
   the envelope's message id must equal the change id
   (`channel_fixture_hydration_failed`); out-of-scope envelopes become
   `absent` observations.
5. Returns the `page.apply` request: `{ action, requestId, connectionId,
   connectionRevision, folderId, expectedRevision, expectedCursor, cursor,
   complete, reset, observations }`.

## `ChannelWebhookInbox` — verified deliveries

- `hash(secret)` — **the only place a plaintext secret enters the server**;
  enforces the strength gate first (422 `weak_webhook_secret`).
- `#match(connectionId, secret)` — constant-time digest compare across all
  accounts holding that connection id (ids are only unique per account);
  requires active `connectionState` for the account's current auth epoch and
  `profileChannel === "telegram"`; accepts the previous digest while a
  rotation is pending (`webhookAcceptsHash`).
- `receive({ connectionId, secret, body, verified })` — match → optional
  `verified` hook (the HTTP route counts per-connection rate limits here) →
  body validation (one Update or `{ updates: [...] }` with exactly one key,
  1–100 updates, safe-integer non-negative `update_id`s) → journal write.
  **Match, validate, journal in one store transaction**: fully recorded or
  refused unchanged. Returns `{ accountId, connectionId, received, accepted,
  rejected, pending }`.
- `rejected(profile, updates)` — pure poison screen: updates the telegram
  adapter cannot normalize are journaled straight to `failed` with the
  contract code (never `pending`; refusing them 4xx would make the provider
  redeliver and stall its queue).
- `pending` / `journal` / `acknowledge` / `fail` — journal accessors; `fail`
  records one bounded attempt per update id.

## `syncTelegramConnection` — account-session import

- Only for telegram, fixture-mode connections.
- **Idempotent request ids**: a retried sync returns the journaled receipt —
  but only for identical content: `sameRecording` replays the pure
  prepare/hydrate/normalize path over the supplied updates and compares
  cursor, completeness, and per-envelope digests (source revisions excluded —
  they're state, not content). Mismatch → 409 `idempotency_conflict`.
- `updates: null` drains the webhook journal's oldest pending slice (≤ 100).
  Journaled poison is failed-and-filtered before prepare; only content/importer
  faults (422, 5xx, unexpected) count against the slice's attempt budget —
  authority/state conflicts (401/403/404/409) are not the updates' fault.
- The page and its acknowledgement commit **in one transaction**: exactly the
  slice rows the page consumed (`update_id < Number(request.cursor)`) turn
  `imported`.

## `ChannelDrainer` — scheduled auto-drain

- `channelDrainLimits`: 60 s interval (`CHANNEL_DRAIN_INTERVAL_MS`; ≤ 0
  disables), 25 connections/cycle, slice = 100 webhook updates, attempts = 5.
- `configured()` — cheap gate: any stored connection or one pending journal
  row; missing tables = never installed. Never throws.
- `scan()` — read-only: telegram connections (by provider id) with pending
  rows, joined to accounts for the current auth epoch; skips non-active
  connections (same rule as the webhook route); oldest-backlog first; JS-side
  `profileChannel` check is the real gate.
- `poisonScreen({ accountId, connectionId })` — session-free: applies the pure
  `rejected` check to the pending slice and records one journaled attempt per
  poison update (bounded → parks as `failed`); neighbours untouched.
- `drainConnection({ accountId, connectionId })` — **without an injected
  `importSlice` authority (B20) this honestly defers**
  (`channel_drain_unavailable`) — the owner's next sync imports the slice.
  Overlap-safe via `#inflight`. Never throws: failures are per-connection
  results (`error` status with a one-line code/message).
- `tick({ deadline, yieldBetween })` — one scheduled cycle: scan →
  poison-screen → drain each; budget-aware; `lastTick` retained.
- `createChannelDrainScheduler({ drainer, intervalMs, onTick })` — unref'd
  interval; a tick that throws is logged and counted; a still-running tick is
  skipped, never stacked.

## Limits (all frozen)

`channelSyncLimits`: pageMessages 50, webhookUpdates 100, webhookBacklog 500,
webhookBodyBytes 65536 (64 KB — a Telegram Update embeds the whole replied-to
message; every other route keeps 16 KB), webhookPerConnection 60,
webhookPerAddress 1200. `webhookSecretLimits`: 16–256 chars, ≥ 6 distinct.
