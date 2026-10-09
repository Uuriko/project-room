# server/public-work-claims.mjs

Public work-claim surface: unpaid project offers that strangers can discover,
claim, work, and submit artifacts for — without room membership. Backed by
three tables (`public_work_tasks`, `public_work_requests`, `public_work_receipts`)
plus a `work_claims` row in a `public_<hash>` namespace. All writes go through
the public-work-claim fence (`withPublicWorkClaimWriter`), and every mutating
call is idempotent via request-id journaling (`public_work_requests`).

## Public API (`PublicWorkClaims` class, constructed with the store)

| Method | Behavior |
|---|---|
| `verifySchema({allowAbsent})` / `available()` | Schema shape check / table-presence probe. |
| `task(offerId)` / `offer(row)` | Fetch task row (404) / re-check publication + unpaid terms (409 when changed). |
| `request(row, actorId, action, input, operation)` | Request-id journal: replays the stored outcome for identical input, 409 `request_id_reused` for the same id with different input. |
| `packet(row, item, offer)` | The public task packet (`public-work-task/1`): terms, files, claim state, generation, receipt id. |
| `read(offerId)` / `list({limit, after})` | Read paths; list filters to published, unarchived, current-terms, unpaid offers with cursor pagination. |
| `enable(roomId, actorId, offerId, input)` | Room owner publishes an offer as public work. Optimistic-concurrency on offer revision + terms version; namespace = `public_<sha256(roomId, repoUrl, ref)>`. |
| `act(offerId, secret, action, input)` | Identity-secret auth; actions `claim`/`renew`/`release`/`finish`. |
| `apply(offerId, identity, action, input, journal=true)` | The serialized claim path shared by direct commands and matchmaking. Claim → in_progress immediately; `finish` writes the artifact receipt (≤64 KiB valid UTF-8) and marks the claim `done` with `deliveryMode: "result"`, `blobs: ["sha256:<hash>"]`. |
| `match(secret, input)` | Recommendation engine: filters unclaimed volunteer tasks, scores by skill/interest keyword match, optional `autoClaim`. |
| `receipt(receiptId, viewer)` / `artifact(receiptId, viewer)` | Receipt JSON / artifact bytes, gated by `_requireReceiptVisible` (403 when the room keeps receipts private and the viewer isn't a member). |
| `receiptRoomId(receiptId)` | Room a receipt belongs to. |

Schema export: `publicWorkClaimsSchema` (three `CREATE TABLE` statements).

## Invariants

- Request IDs are idempotency keys: same id + same input → replayed outcome; same id + different input → 409.
- `leaseHours` is 1 by default, (0, 24] — a stricter cap than board claims (0.25–168).
- Finish is terminal: the generation check runs before the receipt write and before the journal, so a rejected artifact is never persisted and the agent must re-claim.
- The claim namespace is derived from room + repo URL + ref, so the same repo offered twice in one room shares collision space intentionally.
- Matchmaking `autoClaim` writes are fenced; plain recommendations run in a read transaction.

## Top callers

- `server/store.mjs` (constructs `publicWorkClaims`).
- HTTP routes + MCP public-work tools (via store).

## Gotchas

- `enable` lowercases the GitHub repo path — repos that differ only by case share a namespace (intended: same repo).
- `match` with `autoClaim` on `@match` journals the recommendation choice under a synthetic `@match` offer id; direct-command request keys can't alias it.
- `packet` calls `releaseExpired` on the live item — a read that can sweep.
- Artifact verification is `hash_only`: receipts attest to bytes received, not to checks passed. `checksReported` is caller-asserted (≤20, ≤1000 chars each).

## Stale comments

None found — comments (G4/G5 actionable-error notes, #1553 type-vs-range note, generation-before-journal note) match the code.
