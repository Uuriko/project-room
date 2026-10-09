# Attention: attention-inbox.mjs, request-notices.mjs, request-runner.mjs

## attention-inbox.mjs — one explicit read

**Purpose.** `currentAttention({client, origin, roomId, directory, noticeId, signal, now, version})`: a single explicitly-requested read/ack of the attention journal. Never a background poller or model runner; the directory belongs to the configured operator, not to tool arguments or room content.

**Data flow.** Validate version (2|3) → reuse-or-fetch initial snapshot (a failed first access must not leave a new private inbox behind) → `WatchJournal` reconcile via `AssignmentWatcher` → recheck access/conditions → return `{items, pending, hasMore, notifyOnly: true, scope}` or a single ack result.

**Invariants.** `hasMore: count > items.length` (the `>=` mutant is killed — M12). Notices remain pending until explicitly acknowledged. A 250 ms monitor aborts on `journal.shouldStop()`.

**Gotchas.** v3 requires request support in the snapshot (`request_context_unavailable` otherwise).

## request-notices.mjs — reply-request notice projection

**Purpose.** `hasRequestSupport`, `requestNotices(snapshot)`, `validateRequestNotice(notice, signature, key, binding)`: project room reply-requests into attention notices with signatures, and validate the saved form with the *same* projection (so a read pointer can never become a suggested write on restart).

**Invariants.** `validRequest`: id fields valid, `requesterId !== recipientId`, status-dependent `revision` (open→0, else→1) and `terminalEventId` nullness, `recipientAvailable` boolean iff open. `validateRequestNotice` checks exact key sets, the fixed message string, `conditionFor` recomputation, and signature equality.

## request-runner.mjs — explicit execution mode

**Purpose.** `runRequestOnce({connection, requestMessageId, db, execute, signal})`: claim → report → execute → persist → deliver, with a SQLite journal (`openRequestJournal`) so a crash after claiming never silently reruns a host. `runRequestQueue()`: bounded polling loop (10s default, 1–60s allowed, ≤50 requests/scan) with streaming `waitForChange` fast-path. `isRequestEligible(request, {owned, runState, hasPendingDelivery})`: non-open requests are never eligible; owned retry of a saved response additionally requires the request to still be open (G-L2 — the flipped mutant **hangs the suite**, M9).

**Invariants.**
- Request identity is pinned: `viewerId`/`recipientId` must equal `connection.memberId` at start and on every page; a change mid-preparation aborts.
- Intent is persisted *before* the host runs (`INSERT OR IGNORE` claim; a duplicate claim errors instead of double-running). A crash after claiming leaves the journal for reconcile — never a silent rerun.
- Delivery is confirmed by the service's idempotent command path (`receipt.status === "recorded"`), never a stale local assertion; then `delivered=1` is journaled.
- 4xx on the reservation claim deletes the unresponded intent row (definite refusal); network uncertainty keeps it (retry must not infer absence).
- 10-page / 256 KiB preparation caps; 30s heartbeats (`working`) with 10s report timeouts.

**Gotchas.**
- `deliver()` parses `record.response` with a bare `JSON.parse` — a corrupt journal row throws a raw SyntaxError (not a typed error); acceptable because the journal is private and schema-pinned, but a hostile local edit crashes the runner rather than producing `needs_attention`.
- The queue catches per-request errors and emits `needs_attention`, but rethrows on 401/429/5xx/network errors to back off (exponential `delay`, capped 60s).
- M9 note: flipping `isRequestEligible`'s open-check makes the suite hang (>240s) instead of failing cleanly — the queue tests spin waiting for requests that never become eligible. A regression here would present as a stuck runner, not an error.
