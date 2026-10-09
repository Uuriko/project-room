# PRODUCT-200 Reliability — Client Retry Discipline Audit (B9)

Date: 2026-10-08 (PDT) · Worker B9 (respawn) · coordinator: product200-reliability
Repo anchor: `Uuriko/project-room` @ `0a4e6814f` (origin/main head in worktree)
Scope: every CLIENT that issues mutating HTTP calls against the room API —
`src/` (browser web client), `client/` (agent/MCP/CLI clients), `cli/`, `scripts/`.
Method: read-only code inspection. No code changed.

**Headline:** the retry discipline is *split-brain*. A disciplined minority of
client paths (room `/commands`, inbox reserve/review, reminders, share-links,
access-requests) generate one requestId per user action and retain it across
retries. A large tail of mutating call sites — including the **direct channel
send composer** — either send no idempotency key at all or mint a **fresh**
one per attempt, silently defeating the server's dedupe mechanisms (notably
the one PR #2085 just added for direct sends). The failure sequence is always
the same: `POST → 10s client timeout (or dropped response) → server already
committed → user retries → second, different write`. This is the exact pattern
QA-200's update-retry duplicate-history bug came from.

## The client retry model (context)

- `src/client.js:68-78` — `AccountClient.request()`: 10s AbortController
  timeout, **no retry, no idempotency-key generation**. Every retry decision
  lives in the caller.
- `client/room-agent.mjs:236-258` — `discoveryRequest()`: 15s timeout, no retry.
- Timeouts therefore strand ALL mutations in "unknown" state; safety depends
  entirely on what the caller's retry path does with its requestId.

## Findings, ranked by risk

### GAP 1 (HIGH — external side effect) — direct send composer mints a fresh
requestId per submit — `src/inbox-send-ui.js:476-480`

```js
// One idempotency key per user-initiated send: the server replays the
// journaled receipt for a repeated key instead of delivering twice, so an
// uncertain retry (dropped response, double submit) never double-sends.
const data = { channel: el.channel.value, to: el.to.value.trim(), subject: el.subject.value, body: el.body.value,
  requestId: crypto.randomUUID() };
```

The comment states the guarantee, but the guarantee is false for the
`send()` retry path: the key is minted **inside the submit handler**, so a
user who clicks "send" again after a failure (state `failed`,
`directSendErrorText`) sends with a **new** UUID. Server-side dedupe exists
(PR #2085; `direct_send_idempotency_conflict` error code) and is keyed on
`requestId` only — a retried submit with a fresh key bypasses it. Failure
sequence: `POST /api/inbox/channel-sends → timeout after the server sent the
Gmail/Telegram message → "Send failed" → user submits again → second,
distinct message`. Outbox send reserve/cancel/review (lines 168, 174, 379)
do it right — they retain the request in `s.pending`/storage across retries.

**Fix for B11:** hoist the requestId out of the submit handler: mint one
`sendKey` per composer session (or per form-submit *attempt chain*) and retain
it until the send is confirmed sent/failed-final, mirroring the `pending`
pattern at `src/inbox-send-ui.js:379-384`. `validDirectSendResponse` already
validates the receipt; a same-key retry replays it. Exact call site:
`installInboxDirectSend` → `send()` at `src/inbox-send-ui.js:467-497`.

### GAP 2 (HIGH — board is the coordination surface) — work-claim UI sends no
idempotency key on any mutation — `src/board-ui.js:568-651`

Nine endpoints, all `POST` with `{}` or plain payloads, **zero requestId**:

| line | endpoint | payload |
|---|---|---|
| 568 | `/work-claims/sweep` | `{}` |
| 572 | `/{id}/claim` | `{}` |
| 573 | `/{id}/release` | `{}` |
| 574 | `/{id}/close`, `/{id}/cancel` | `{}` |
| 575-576 | `/{id}/update` | `{ state }` |
| 578 | `/{id}/renew` | `{}` |
| 617 | `/{id}/update` (PR link) | `{ appendPullRequest, expectedClaimedAt, expectedHistoryLength }` |
| 633 | `POST /work-claims` (create) | `{ id, title, ... }` |
| 642 | `/{id}/reassign` | `{ newOwner }` |
| 651 | `/work-claims/config` | `{ maxMemberOpenClaims }` |

`act()` (line ~521) does not auto-retry, but after the 10s client timeout the
user clicks again — the QA-200 pattern. Mitigations in place: `/{id}/update`
has the compare-and-release concurrency token from #2088
(`expectedClaimedAt` + `expectedHistoryLength`, line 596-597), so a stale
retry 409s. But **create, renew, reassign, sweep, config, claim, release,
close, cancel have no token and no server-side requestId support**
(`server/work-claim-routes.mjs` has no requestId/idempotency handling —
compare B12's report, which marks work-claims COVERED only via the create-409
and compare-and-release guards, not via a client key).

Worst sub-cases: (a) `/{id}/renew` (578) — retry after a committed renewal
extends the lease twice, silently; (b) `POST /work-claims` (633) — the id is
`claimIdFromTitle(title)` (line 346), deterministic per title, so a same-title
retry likely 409s server-side, but two different users with the same title
collide; (c) `/{id}/reassign` (642) — retry after a committed reassign is a
no-op only if the server's state check holds, which is not the client's to
assume.

**Fix for B11:** add a client-generated `requestId` to every `act()` payload
in `src/board-ui.js:568-651` (mint once per `act()` invocation, not per
click), and add server-side requestId acceptance + replay for the
work-claims routes. Minimum viable: accept `requestId` and return the prior
receipt on replay for the four non-idempotent-by-state endpoints —
`POST /work-claims`, `/{id}/renew`, `/{id}/reassign`, `/{id}/sweep`.

### GAP 3 (MEDIUM-HIGH — identity duplication) — anonymous `/join` accepts no
idempotency key, and the server rejects one — `src/join.js:239`,
`server/http.mjs:2659`

The join page POSTs `{ displayName, inviteCode }` with no key, and the button
is re-enabled on failure so the user retries (`src/join.js:239-250`). On the
**invite branch** the consumed single-use code is the backstop
(`invite_already_used`). On the **anonymous branch** (no invite code) the
server atomically mints an identity AND a personal room — and rejects any
extra body field via `exact(data, joinFields)` (`server/http.mjs:2659`), so
the client cannot even send a key. Failure sequence: `POST /join → response
lost after commit → user retries → second identity + second personal room`,
with the first secret shown once and effectively orphaned. This matches B3's
finding for `/api/agent-identities` (server rejects client keys).

**Fix for B11:** server-side: accept `requestId` on `POST /join` (relax
`exact()`), keyed replay on identity-mint. Client-side: mint one `requestId`
per join-page session in `src/join.js` and send it; keep the retry button
behavior. Same treatment needed for `mintAccessIdentity`
(`src/client.js:211`) / `POST /api/agent-identities` (PoW is re-solved per
retry today, so a retried mint burns PoW twice and mints twice).

### GAP 4 (MEDIUM) — DM consent mutating calls send no key —
`src/dm-consents.js:165-186`

`POST /dm-consents` (create request), `/{requesterId}/decide`,
`/dm-consents/revoke`, `/block`, `/unblock` — none carries a requestId. The
decide/revoke/block/unblock transitions are state-flips (server guards
likely apply) but the **create** is additive: a timed-out consent request
retry creates a duplicate pending request. **Fix:** mint-and-retain one
`requestId` per consent-request draft (pattern: `src/reminders.js:139`).

### GAP 5 (MEDIUM) — squad create/disband keyless — `src/squads-ui.js:123,133`

`POST /squads` with `{ name, goal, memberIds }` and `POST /squads/{id}/disband`
with `{}`. A retried create after a timeout makes two squads. **Fix:** same
mint-and-retain treatment as GAP 4.

### GAP 6 (LOW-MEDIUM) — access-request approve/deny has no client key —
`src/needs-attention.js:53-54, 192`

`POST` with `{ decision, permissions, note }`. The server's `already_decided`
guard (handled at line 199-200) makes this mostly safe, but the client
should not lean on it: two owners deciding concurrently, or a retry after a
timeout, race on server state. **Fix:** mint one `requestId` per decide
action; the permission-request *create* path (line 348) already carries
`requestId: sent.requestId` — good.

### GAP 7 (LOW) — message reports keyless — `src/app.js:5217`

`client.reports({ messageId, reason })` — no requestId. Retry → duplicate
report to the owner. Server dedupes on `(messageId, reporter)` per the
`result.duplicate` handling, but the client shouldn't depend on it. **Fix:**
include a per-dialog `requestId` (the report dialog opens fresh per report).

### GAP 8 (LOW) — CLI code-share checks keyless — `cli/commands/code.mjs:209,249`

`POST /{id}/checks` with `{ verdict, applies, onBase, tests, note }` — no key.
A retried `room code check` after a timeout appends a second check verdict.
(The `share` POST at line 138 is safe: server returns `duplicate`.) **Fix:**
CLI should mint one requestId per command invocation and reuse across its
single retry path (CLI does not auto-retry today, so this is user-level).

### GAP 9 (LOW) — quarantine release/dismiss/split keyless —
`src/inbox-client.js:263,267,271`

`POST /api/inbox/quarantine/{release,dismiss,split}` with `{ quarantineId,
note }`; the route schema (`server/routes/inbox.mjs:441-443`) accepts no
requestId. These are guarded state transitions (held → released/dismissed),
so the practical risk is a confusing "already decided" retry, not
duplication. **Fix:** accept-and-ignore or honor `requestId` server-side for
uniformity; low priority.

## Verified GOOD (keep as the house pattern)

These do exactly what the task asks — one key per user action, retained
across retries, regenerated only when the payload changes:

- **Room `/commands`**: `draftCommand` retains the same command `id` for an
  unchanged payload; `retryUnconfirmed` gates the retry
  (`src/client.js:915-930`; call sites in `src/app.js`: messages 3925, work
  proposals 5756-5766, action forms 6286-6316, reactions 4921, pins 4878).
- **Inbox reserve/cancel/review**: `s.pending` / sessionStorage retention with
  the same `requestId` (`src/inbox-send-ui.js:162-177, 379-384`).
- **Reminders**: `pending` map, cleared only on non-uncertain failure
  (`src/reminders.js:139-161`).
- **Share links**: `pendingCreate ||= { requestId, linkToken, ... }`
  (`src/share-links.js:453-456`).
- **Access requests**: `newAccessRequestId()` minted once, stashed for retry
  (`src/request-access.js:43-72`).
- **Project offers**: `pending` retained per operation; nulled only on 4xx
  (`src/owner-project-offers-ui.js:127-139, 218`).
- **Human-experience configure**: `configureOperation ??=` retains requestId
  (`src/human-experience.js:58`).
- **Spend pricing**: `flipSpendPricing` takes caller-supplied `requestId`
  with `newRequestId()` fallback (`src/spend-pricing-ui.js:55`).
- **MCP stdio tools** (`client/mcp-stdio.mjs:47-51, 151-200`): require a
  *stable* model-supplied `requestId` and document "do not generate a new
  requestId on retry" — sound, but **unenforced**: nothing stops the model
  from minting a fresh UUID on retry (cf. B12: `room_post_message` defaults
  `id` to `randomUUID()`). Enforcement gap, not a client bug per se.

## Timeout-without-retry: intended, but callers vary

The 10s (`src/client.js`) / 15s (`client/room-agent.mjs`) timeouts never
retry by design — the failure state stays "unknown" and each UI decides.
The honest ones say "check status before continuing" (inbox send drive,
`src/inbox-send-ui.js:150-158`). The dangerous ones are the silent ones:
`board-ui.js`'s `act()` shows only "Could not update the claim" with an
immediate clickable retry (GAP 2), and `join.js` re-enables submit (GAP 3).

## Recommendations for B11 / follow-up (fix-ready, call-site exact)

1. **Hoist the direct-send key** — `src/inbox-send-ui.js:467-497`: move
   `requestId: crypto.randomUUID()` out of `send()` into composer state;
   retain across submits until a terminal receipt. (Server already dedupes
   per #2085; this is a client-only fix.)
2. **Key the board mutations** — `src/board-ui.js:568-651`: one requestId per
   `act()`; server: accept + replay requestId on `POST /work-claims`,
   `/{id}/renew`, `/{id}/reassign`, `/{id}/sweep` (the four without
   server-side guards).
3. **Key identity mint/join** — `src/join.js:239` + `server/http.mjs:2653-2659`
   (relax `exact()` to accept `requestId`); `src/client.js:211`
   (`mintAccessIdentity`) + `server/agent-identities.mjs`.
4. **Key additive creates** — `src/dm-consents.js:165` (consent request),
   `src/squads-ui.js:123` (squad create); follow the `src/reminders.js:139`
   mint-and-retain pattern.
5. **Low tail** — `src/needs-attention.js:192` (decide), `src/app.js:5217`
   (reports), `cli/commands/code.mjs:209,249` (checks): add caller-minted
   requestId; server may ignore where guards already exist.
6. **Harden the MCP contract** — enforce requestId stability server-side
   (reject a retry-context new key where the journal shows the old one), or
   accept B12's `room_post_message` default-id risk as documented.

## Caveats

- Read-only audit; no tests run, no behavior executed. Server-side dedupe
  claims for work-claims/access-requests rely on B12's report + the cited
  PRs (#2045, #2086, #2088), not re-verified here.
- `scripts/` mutating room-API surface: none found — `scripts/room` only
  POSTs to GitHub (`scripts/room:295`); probe/check scripts are reads.
- `src/client.js` line numbers refer to the anchor commit `0a4e6814f`.
