# Cross-Channel Thread Stitching — Design

**Task:** project-room tasks #19 (design) / #20 (privacy approval gate) / #27 (unified participant profiles).
**Status:** design only. No code in this PR. Shipping is gated: stitching stays **inert** until John approves
the heuristic policy in task #20, and task #27's merge mechanics sit behind the same flag.

## 1. Goal

Link a Telegram chat and an email thread (and later X DMs) into one unified conversation timeline when they
share a real-world participant, so the thread view (`server/inbox-threads.mjs`'s `buildThreads`, wrapped by
the unified-inbox slice) can show one conversation with per-message channel badges (Email / Telegram / X).

Stitching is a **read-path enrichment**, not a data merge:

- Envelopes stay channel-native. `sourceId`, `threadId`, and journal rows (`pending_channel_updates`,
  per-channel journals) are never rewritten by stitching.
- The stitch layer produces a **stitch graph**: `stitched_thread_id → [ {channel, sourceId}, … ]`, computed
  from participants, never from message bodies.
- Thread view renders the stitched timeline sorted by `sentAt`, each entry badged with its channel.

## 2. Identity inventory (grounded in the adapters)

Every adapter already normalizes participants to one shape (`server/channel-connection.mjs`):

```
{ kind, id, handle, displayName }
```

kind ∈ `mailbox | user | bot | chat | group | channel`.

| Channel | kind | `id` | `handle` | `displayName` | Adapter |
|---|---|---|---|---|---|
| Telegram (bot API) | `user` / `bot` | numeric user id as string | `@username` or `""` | first+last name | `server/channel-adapters/telegram.mjs` `participant()` |
| Telegram chat | `chat` | numeric chat id | `@username` or `""` | chat title | same |
| Gmail | `mailbox` | email address | email address | display name | `toChannelProfile()` mapping (identity: `{kind:"mailbox", id: address, handle: address, displayName: name}`) |
| X | — | — | — | — | **no adapter yet**; design reserves `handle` = `@handle`, `id` = numeric user id, kind `user` |

Only `handle` and `displayName` (and, for email, the address inside `id`/`handle`) are stitchable.
Numeric Telegram user ids are **never** comparable across channels, so they are not stitch inputs —
they are only used as channel-native join keys for the read-path lookup (see §4).

## 3. Hashed-identifier index — no PII persistence

Raw emails, handles, and display names are **never** stored in the stitching index. They exist only in
envelopes (already true today) and are resolved at read time.

### 3.1 Normalization (before hashing)

Deterministic string normalization applied per identifier type:

- `handle`: trim, lowercase (Unicode casefold), strip one leading `@`. `@Alice` and `alice` → `alice`.
- `email`: trim, lowercase. Local-part and domain are both casefolded. Plus-tags and Gmail dot-insensitivity
  are **not** normalized away at v1 (provider-specific rewriting is a false-positive factory); they are
  candidates for a v2 allowlist, never silent rewrites.
- `displayName`: trim, collapse internal whitespace, casefold. Used for probabilistic scoring only,
  never as a hash index key (names collide far too often for an equality index).

Normalization is pure and versioned: `norm:v1`. If normalization rules change, hash inputs change,
so the hash carries a version prefix (see below) and re-indexing is a fresh pass, never a mutation.

### 3.2 Hash construction

```
stitch_key = "v1:" + hex( HMAC-SHA256( salt, norm:v1 + "|" + type + "|" + normalized_value ) )
```

- **Algorithm:** HMAC-SHA256. Chosen over plain SHA-256 (which the adapters already use for `sourceId`
  digests) because a keyed hash resists rainbow tables and cross-install correlation if the DB leaks.
- **Salt:** a per-installation 256-bit secret, generated once, stored in the same secure credential store
  as other channel secrets — **never in the SQLite DB, never in logs, never exported with backups of the DB**.
  The stitch module receives it as an injected dependency (constructor arg), exactly like a transport
  receives its reader in the adapters' `bind()` pattern.
- **Salt rotation:** supported by the `v1:` epoch prefix. Rotation bumps the epoch (`v2:`), rebuilds the
  index in one pass from envelopes, and drops the old epoch rows. There is no in-place re-keying.
- **Type tag:** `email` | `handle` are separate namespaces. A Telegram handle `alice` and an email local-part
  `alice` must never share a hash — cross-type equality is a heuristic decision (§5), not an index fact.

### 3.3 The index table

```sql
CREATE TABLE IF NOT EXISTS stitch_identities (
  stitch_key   TEXT PRIMARY KEY,   -- "v1:" + hmac, never the raw identifier
  id_type      TEXT NOT NULL,      -- 'email' | 'handle'
  channel      TEXT NOT NULL,      -- first-seen channel
  kind         TEXT NOT NULL,      -- participant kind
  first_seen   TEXT NOT NULL,      -- ISO instant
  last_seen    TEXT NOT NULL,      -- ISO instant
  occurrences  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stitch_links (
  stitch_key   TEXT NOT NULL,      -- hashed identifier
  channel      TEXT NOT NULL,      -- 'telegram' | 'email' | 'x'
  source_id    TEXT NOT NULL,      -- envelope sourceId (channel-native, opaque)
  linked_at    TEXT NOT NULL,
  link_rule    TEXT NOT NULL,      -- 'exact' | 'verified' | 'probabilistic'
  link_score   REAL,               -- null for exact/verified
  PRIMARY KEY (stitch_key, channel, source_id)
);
```

`stitch_identities` answers "have we seen this hashed identifier before" without ever revealing it.
`stitch_links` answers "which channel-native messages share it". A stitch is formed at read time by
joining `stitch_links` → envelopes. Deleting the two tables destroys all stitching with zero PII residue.

## 4. Read-path resolution (how raw PII never lands in the index)

Stitching never scans stored PII. The flow per inbound envelope:

1. Importer normalizes the envelope's participant (`handle`/`displayName`/email fields) **in memory**.
2. It computes `stitch_key` candidates in memory using the injected salt.
3. It queries `stitch_identities` by `stitch_key` — the query carries only hashes.
4. On hit, it inserts a `stitch_links` row (hashes + opaque `sourceId` only) and bumps counters.
5. On miss with a usable identifier, it inserts the new `stitch_identities` row (hash only) and links.
6. On no usable identifier (§8), nothing is written; the envelope keeps its channel-native thread.

The raw identifier never crosses the store boundary. Envelopes keep their PII as today; the stitch
index is a parallel hash-only structure.

## 5. Stitching rules and precedence

Rules are evaluated in precedence order. Higher-precedence links **win**; lower rules only add
`suggested` edges that require confirmation (§6).

| Prec. | Rule | Input | Link type | Auto? |
|---|---|---|---|---|
| 1 | **Exact identifier match** | same `stitch_key` (same type, same channel-normalized value) across ≥2 channels | `exact` | Yes — score 1.0 |
| 2 | **Verified link** | owner confirms a suggested link (receipt journaled, §6) | `verified` | Yes — human action |
| 3 | **Probabilistic match** | scored heuristics below | `probabilistic` | No — suggestion only |

### 5.1 Deterministic (precedence 1)

Exact equality of the hashed normalized identifier **within one type namespace**:

- email ↔ email: same normalized address on Gmail and on a future email provider, or in a Telegram
  participant's `displayName`? **No.** Cross-field matching (handle vs displayName vs address) is never
  deterministic. Deterministic = same field, same type, byte-equal after normalization.
- handle ↔ handle: Telegram `@alice` and X `@alice` hash to the same key **only if** the future X adapter
  uses the same `norm:v1` + `handle` namespace. This is the one cross-channel deterministic case, and it is
  exact because handles are platform-allocated unique names (with the handle-reuse caveat, §7).

Bots (`kind: "bot"`) and channels (`kind: "channel"`) are excluded from deterministic stitching:
bot usernames are often shared infrastructure, not people.

### 5.2 Probabilistic (precedence 3 — suggestions only)

Each heuristic emits a 0..1 component score; the composite is a weighted sum. Weights are config,
defaults below:

| Heuristic | Signal | Default weight |
|---|---|---|
| `name_sim` | Jaro-Winkler similarity of normalized displayNames ≥ 0.85 | 0.35 |
| `localpart_handle` | email local-part equals normalized handle (casefolded), or handle equals local-part | 0.30 |
| `handle_fuzzy` | normalized Levenshtein(handle_a, handle_b) ≤ 1 on handles ≥ 5 chars | 0.15 |
| `temporal` | both participants active within a 72h window with ≥ 2 interleaved messages | 0.10 |
| `context` | shared distinctive token in subjects/thread titles (length ≥ 8, not in stop-list) | 0.10 |

Composite thresholds (config):

- **≥ 0.90:** high-confidence suggestion, surfaced first in the review queue.
- **0.60–0.90:** suggestion, shown with its component breakdown.
- **< 0.60:** discarded, counted in `thread:stitch:probabilistic:discarded`.

Probabilistic links **never** auto-form. They appear in a review queue; forming the link requires the
owner's tap (→ precedence 2, `verified`). This is the task-#20 policy boundary made mechanical:
the fuzzy/strict choice John approves is exactly the threshold config + whether the queue is on.

### 5.3 Precedence conflicts

- A `verified` link beats a contradicting `exact` link (owner knowledge > string equality).
- Two `exact` links claiming the same participant from different identifiers (e.g. handle changed hands)
  → §7 conflict path.
- Probabilistic suggestions for an identifier that already has an `exact`/`verified` link are suppressed
  (no duplicate suggestions), counted in `thread:stitch:probabilistic:suppressed`.

## 6. Merge, split, conflict

All three mutate only the hash index + links, never envelopes, and every one journals a receipt
(mirroring the room's claim/receipt discipline on #266-style journals).

### 6.1 Merge

Forming a link (exact auto-form, or owner-confirmed suggestion) writes `stitch_links` rows under one
canonical `stitch_key` and emits `thread:stitch:merged`. Merges are **reversible within 30 days**:
the journaled receipt carries `{ stitch_key, source_ids, rule, score, confirmed_by, confirmed_at }`
and an undo writes a `stitch_revocations` row that blocks re-forming that exact link.

### 6.2 Split

The owner can split a stitched identity: all `stitch_links` rows for the contested `(stitch_key, channel,
source_id)` set are deleted, a revocation row is written with the reason, and the identifier that caused
the false stitch is added to a per-key **deny-list** so the exact rule cannot silently re-stitch it.
Split emits `thread:stitch:split`. Splits are permanent unless the owner re-verifies (→ `verified` link,
which overrides the deny-list).

### 6.3 Conflict

A conflict is detected, never auto-resolved:

- Two different `displayName`s (similarity < 0.5) attached to the same exact `stitch_key` over time
  (handle reuse / address reassignment).
- A `verified` link contradicting an `exact` link.

On conflict: the contested links are **quarantined** (excluded from the stitched timeline, kept in the
index with `link_rule = 'quarantined'`), the thread view falls back to channel-native threads, and
`thread:stitch:conflict` fires with the hashed keys only. Resolution is owner-only: pick the surviving
identity (→ verified) or split (§6.2). Quarantine is the default safe state — a wrong stitch shown as
one conversation is worse than two threads shown separately.

## 7. Handle-reuse and address-reassignment guard

Handles get recycled (Telegram usernames, X handles) and email addresses get reassigned. Guard:

- `stitch_identities` tracks a rolling `displayName` similarity fingerprint (hashed bigrams, not the name):
  if the fingerprint of new sightings diverges from the established one below 0.5 while the identifier
  hash stays constant, flag `suspected_reuse` → automatic quarantine (§6.3) pending review.
- First-seen provenance: a link formed from an identifier first seen < 7 days ago carries a
  `provisional` marker in the UI until it ages out. New identifiers are the highest-risk ones.

## 8. Graceful degradation (no usable identifier)

Common cases: Telegram participant with `handle: ""` and empty `displayName` (privacy-restricted user);
email with a bare address and no display name is still fine (the address is the identifier); a group chat
participant with neither.

Behavior:

- The envelope imports normally — **stitching never blocks ingestion**. It keeps its channel-native
  `threadId` thread.
- It is tagged in the read model as `stitch: "deferred"` with a reason code:
  `no_identifier | bot_excluded | insufficient_signal`.
- `thread:stitch:unstitched{reason}` counts it.
- If a usable identifier arrives later (e.g. the user sets a username), the next import pass links
  retroactively: link rows are backfilled for prior messages from the same channel-native participant id,
  emitting `thread:stitch:backfilled`. No re-import, no envelope rewrite.

Partial signal (displayName only, no handle/address) feeds probabilistic heuristics but can never form
an exact link — deterministic rules require a hash-index key, which requires a handle or address.

## 9. Thread view: stitched timeline

- `buildThreads` stays channel-native and pure (unchanged contract — deterministic, no store access).
- A new pure function `stitchThreads(threads, links)` (future `server/inbox-stitch.mjs`) takes the
  channel-native threads plus the stitch graph and returns stitched timelines:
  `{ stitchedThreadId, channels: ["email","telegram"], entries: [...], depth preserved per source thread }`.
- Each entry carries `channel` for the per-message badge (Email / Telegram / X) already established in
  the unified inbox list (`docs/UNIFIED-INBOX.md`: "each row with a channel badge").
- Reply-tree depth is computed within the source thread; cross-channel `inReplyTo` does not exist, so
  stitched entries interleave by `sentAt` at depth 0 with a `stitched: true` marker and a link back to
  their source thread. Quarantined links are excluded.
- Stitched view is **opt-in per user** and off until task #20 approval; the API returns both
  `threads` (native) and `stitchedThreads` so the client can toggle without a second fetch.

## 10. Metrics

Namespace `thread:stitch:*`, colon-delimited, following the existing `signin:fail:*` style
(`<domain>:<object>:<event>`).

Counters (all carry `{channel?}` / `{rule?}` labels where meaningful, hashed keys never in labels):

| Metric | Meaning |
|---|---|
| `thread:stitch:identity:indexed` | new hashed identifier added to the index |
| `thread:stitch:exact:formed` | deterministic link auto-formed |
| `thread:stitch:probabilistic:suggested` | suggestion entered the review queue (with score bucket) |
| `thread:stitch:probabilistic:discarded` | below threshold |
| `thread:stitch:probabilistic:suppressed` | skipped, identifier already linked |
| `thread:stitch:verified:confirmed` | owner confirmed a suggestion |
| `thread:stitch:merged` | links materialized into a stitched timeline |
| `thread:stitch:split` | owner split a stitched identity |
| `thread:stitch:conflict` | quarantine triggered |
| `thread:stitch:backfilled` | retroactive linking after late identifier arrival |
| `thread:stitch:unstitched{reason}` | envelope with no usable identifier |

Quality metrics (measured, not just counted):

- **Precision targets:** deterministic (`exact`) links ≥ **0.995**; owner-confirmed (`verified`) ≥ **0.99**;
  high-confidence probabilistic suggestions (≥ 0.90) ≥ **0.90**; all suggestions ≥ **0.80**.
- **Recall target:** ≥ **0.70** of ground-truth cross-channel identities stitched, measured on a labeled
  sample of the owner's own contacts (the only ground truth available without violating the no-PII rule —
  labels are contact-local and stored as hashes too).
- **Measurement:** weekly sampled audit — N=50 random formed links re-judged by the owner in the review
  queue; precision = confirmed / (confirmed + split + conflict). Reported on the inbox diagnostics surface
  next to channel health. If deterministic precision drops below 0.99, auto-forming pauses and every new
  exact link becomes a suggestion until the cause is found (fail-closed on quality).

## 11. Privacy review checklist

- [ ] Index stores **hashes only** — no raw emails, handles, or display names in `stitch_identities`,
      `stitch_links`, `stitch_revocations`, or any metric label.
- [ ] Salt lives in the secure credential store, injected like a transport reader; never in SQLite,
      logs, backups of the DB, or the repo.
- [ ] Salt rotation procedure documented and tested (epoch prefix bump + single rebuild pass).
- [ ] Metric labels and log lines reviewed: no identifier material in `thread:stitch:*` payloads.
- [ ] Review-queue UI shows the *candidate* identifiers to the owner only (in-session, from envelopes —
      never persisted as review artifacts).
- [ ] Per-contact opt-out: a contact-level flag suppresses all stitching for that hashed identifier
      (deny-list entry), honored by exact and probabilistic rules alike.
- [ ] Export/delete: deleting a contact's data deletes their `stitch_links` + `stitch_identities` rows;
      with hashes only, this is complete by construction.
- [ ] Task #20 approval recorded before the `stitching.enabled` flag can be set (flag defaults off;
      inert code path — stitch functions exist but the importer never calls them).
- [ ] Third-party doctrine: stitched timelines never leave the room's own store (no syncing the stitch
      graph to external services).
- [ ] Audit: weekly precision sample (§10) doubles as the ongoing privacy/quality review.

## 12. Implementation plan (for the build slice, not this doc)

1. `server/inbox-stitch.mjs` — pure functions: `normalizeIdentifier`, `stitchKey` (HMAC, injected salt),
   `scorePair` (heuristics + weights), `stitchThreads` (pure timeline merge). Unit-tested, no store.
2. Store: `stitch_identities`, `stitch_links`, `stitch_revocations` tables behind the writer fence;
   additive-only migrations.
3. Importer hook: after envelope journaling, compute candidates in memory, write hash-only rows.
   Skipped entirely when `stitching.enabled` is false.
4. HTTP: `GET /api/inbox/threads` returns `{ threads, stitchedThreads }`; review-queue endpoints
   `POST /api/inbox/stitch/{confirm,split}` journaling receipts.
5. Diagnostics: `thread:stitch:*` counters on the inbox diagnostics surface; weekly audit sampler.
6. X adapter (future): reserves the `handle` namespace and `norm:v1` — no index changes needed when it lands.

## 13. Non-goals

- No message-body content analysis for stitching (participants only).
- No cross-room or cross-account stitching (one installation, one owner's graph).
- No ML entity resolution — weighted heuristics with owner confirmation are the whole system at v1.
- No changes to login/auth code paths (quill's lane) — stitching is inbox-internal.
