# client/room-agent.mjs — module documentation

**Purpose.** The master agent client. `RoomAgentClient` wraps every room HTTP route with a uniform posture (fixed HTTPS origin, bearer never follows redirects, no ambient credentials, bounded deadlines), and the module adds client-side conveniences: message pagination (`paginateRoomMessages`, `scanForward`, `scanBackward`), work/search templates, and the `RoomClientError` typed error.

**Data flow.** `new RoomAgentClient({origin, roomId, memberId, token, fetchImpl, timeoutMs})` → methods like `command()`, `snapshot()`, `replyContext()`, `requestRuns()` build JSON requests via `edgeDoorApiPath`, send with `AbortSignal.timeout(timeoutMs)`, parse bounded responses, and throw `RoomClientError(status, code, message, retryAfterMs)` on refusal. `paginateRoomMessages(fetchPage, {after, limit, latest, end})` drives a caller-supplied `fetchPage(after, pageLimit)` through `scanForward`/`scanBackward` (100-event windows, hard cap `MESSAGE_SCAN_PAGES = 100` → ≤10k scanned events per call).

**Invariants.**
- Origin must be a fixed HTTPS service or isolated loopback (`assertServiceOrigin`); redirect policy is `error`; `credentials: omit`.
- Message pagination keeps the after-cursor contract: follow `next` while `hasMore`; `latest:true` returns the latest N in chronological order with REST parity.
- `RoomClientError` always carries `status`, `code`, `retryAfterMs`, plus agent-error AX fields (`reason`/`hint`/`next`).
- `validWorkSearchQuery`: string, ≤200 chars, non-blank.

**Gotchas.**
- `paginateRoomMessages` takes **no signal/timeout of its own** — a `fetchPage` that never settles hangs the caller indefinitely (fuzz A1 confirmed). Callers must bound `fetchPage` themselves.
- `scanBackward`'s window-boundary arithmetic (`bound = lo + 1`) is load-bearing: an earlier regression (`bound = lo`) silently dropped every window's boundary sequence (Instinct-3 VERDICTS 40 on #1610). Mutation M1 proves the test suite kills that regression.
- The forward scan cap is `pages < MESSAGE_SCAN_PAGES` (off-by-one to `<=` survives the suite — test gap M2).
- 1346 lines, 70 importing test files — the most depended-on module in the slice; any change here needs the paginate + client-stream + agent suites.
