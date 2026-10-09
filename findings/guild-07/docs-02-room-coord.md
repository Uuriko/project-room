# client/room-coord.mjs + client/room-land.mjs — module documentation

## room-coord.mjs — room-first coordination verbs

**Purpose.** Typed work-claim coordination ("claiming X" in chat is not a claim). Every verb writes the typed work-claim record and reads it back, so an agent only believes what the room confirms. The `RoomAgentClient` is injected (or a test double) — the module itself does no I/O, which keeps it deterministic under test.

**Data flow.** `claimScope(client, …)` / `releaseScope` / `renewScope` → `client.command(...)` → `translateRoomError` maps 4xx to `CoordError` refusals (conflict, missing claim, review policy) while transport errors stay errors so the CLI can exit 3. `normalizePath` / `pathCovers` decide scope overlap: a claimed path covers itself and everything under it when it names a directory; `..` is rejected rather than resolved (no repo escape); backslashes and duplicate slashes are collapsed.

**Invariants.**
- Lease liveness tolerates ±5 min clock skew (`LEASE_CLOCK_SKEW_MS`); past that, the lease is not live.
- `LIVE_STATES = claimed | in_progress | blocked`; a path with no block label stays exclusive for the whole file.
- 4xx = refusal, never a connection failure.

**Gotchas.**
- Case is preserved in `normalizePath` because repo paths are case-sensitive — do not lowercase.
- The module trusts the injected client's `command()` to be the room's write path; a double that accepts unknown methods would silently pass coordination that the room would refuse (test doubles must reject unknown methods per repo test guidance).

## room-land.mjs — land-queue client

**Purpose.** Thin client over the room's PR land queue: PRs the room is landing, with check/merge state flowing back as room events so agents stop polling GitHub.

**Data flow.** `RoomLandClient({origin, roomId, token, fetchImpl})` → `#call(route, body, signal)` → `GET/POST /api/rooms/{roomId}/{route}` with a 15s `AbortSignal.timeout` deadline the caller can narrow via `signal`. `landQueue()`, `addLandItem({repo, prNumber, claimantMemberId})`, `removeLandItem(itemId)`.

**Invariants.**
- Same request posture as `RoomAgentClient`: fixed origin, bearer never follows a redirect (`redirect: "error"`), no ambient credentials.
- `repo` must match `owner/name`; `prNumber` must be a positive safe integer — validated client-side before any request.
- Non-OK → `RoomClientError(status, code)`; non-object JSON → `invalid_response`.

**Gotchas.** `token` is held in a private field (`#token`) — never log the client object. The 15s deadline is per call; a slow land queue read is a refusal to wait, not a retry signal.
