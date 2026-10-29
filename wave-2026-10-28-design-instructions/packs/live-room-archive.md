# Instruction Pack — Live-Room Archive (message archive on a room that stays live)

Slug: `live-room-archive` · Wave: 2026-10-28-design-instructions · Target tree: **main `aaa749065a6451321a949ddcb923f3174504fe35`** (read via `git archive` of that SHA into lane scratch, 2026-10-28), plus bound PR head `156eb4b0f3dc769d1333bebe0c3edeea067ce3a0` for #4265 (also read via `git archive`). Production is build `ca37fee4` per the wave brief; no production write of any kind is instructed here, and no production read was run by this lane — production facts below are cited from executed evidence on file and are dated.

This pack is **executable now** (it is not a redesign typed-object piece; the FOCUS-REVIEW pause does not gate it). Two sub-steps stop at named gates that belong to John or the landing seat — see §4 Step 0 and §6.

---

## 1. The piece

### 1.1 What it is — and what it is not

"Live-room archive" is the **message/projection archive**: older messages of a room are moved out of the room's stored projection into the messages table, the room's projection shrinks, and **the room stays fully live** — members keep posting, reading, searching, and exporting, including the archived messages. It exists to keep a room under the 4 MiB per-room projection cap (`PILOT_LIMITS.projectionBytes`); past the cap every write to the room is refused 409 `pilot_limit`.

It is **not** either of the other two things also called "archive" in this codebase. Do not touch them in this piece, and do not reuse their copy, flags, or UI:

| Not this piece | Where it lives at main `aaa749065a` | Behaviour |
|---|---|---|
| Room **lifecycle** archive (owner archives the whole room; room becomes read-only) | `src/events.js` `archiveRoom()`; `src/app.js` `syncRoomLifecycle()` renders `#room-archived-note` ("Archived ⟨date⟩ by ⟨name⟩ · read only…"), disables the composer, placeholder "This room is archived." | Whole-room, owner-only, irreversible in UI |
| **Channel** archive | `src/events.js` `archiveChannel()`; `src/app.js` channel manage UI ("Archive channel" / "Confirm archive") | One channel, owner-only |

The single most likely implementer error in this piece is confusing the message archive with the lifecycle archive and making a message-archived room look or behave read-only. It must never do that (§3, §5 check A6).

### 1.2 Where it lives (all verified at main `aaa749065a` unless named otherwise)

**Store / archive engine**

- `server/messages-store.mjs` — `archiveRoomMessages(store, roomId, { keepNewest = 2000, dryRun = true, belowCursor = false })` (~line 1498); `archiveMarker(db, roomId)` (~line 411) reads the marker stored in the projection as `state.messagesArchive = { throughSeq, count, retainedIds }` (~line 1588); `restoreArchivedMessages(store, roomId)` (~line 1612) puts every moved message back from the event log. Retained set (never moved): pinned messages, work sources/evidence, reply requests, open threads, and everything a later event names.
- `server/store.mjs` — `archiveMessages(roomId, options)` (~line 2254, "Default-off compaction (dry run unless dryRun:false)"); the cap refusals at ~lines 3585, 4525, 6286 raise 409 `pilot_limit` with the text "Room projection limit reached; no data was changed. Ask the room owner to have older messages archived to free space." (the owner has no such door — see §2.5).

**Operator door (merged #4123)**

- `server/operator-archive.mjs` — `operatorArchive(store, input, requestId)`. Contract, verbatim from code: fields only `roomId`, `keepNewest`, `dryRun`, `reason`, `expect`, `belowCursor`; `keepNewest` default **2000**, min 100, max 100,000 (`ARCHIVE_DEFAULT_KEEP/MIN_KEEP/MAX_KEEP`); `reason` required, 1–200 chars; `dryRun` defaults `true`; a real run must carry `expect: { archived, throughSeq }` copied from a dry run of the same room and `keepNewest`, and refuses 409 `plan_changed` if the plan moved; before planning it catches the room's messages table up and certifies it at head synchronously (bounded: 20 calls, `CATCH_UP_EVENT_CAP` 4,000 events, 15 s budget), refusing 409 `archive_not_ready` with the step named (`backfill_blocked` / `backfill_not_caught_up` / `parity_failed`); `belowCursor: true` skips catch-up and archives only below the parked cursor. Every call writes an `operator_actions` audit row (`messages_archive_plan` / `messages_archive`) including `projectionBytes: { before, after }`. Response: `{ ok, roomId, dryRun, keepNewest, archived, retained, freedBytes, throughSeq, projectionBytes: { before, after }, expect }` (plus `cursorSeq`/`touchedKept` in `belowCursor` mode).
- `server/operator-routes.mjs` — `POST /api/operator/archive` is the only archive route. Auth: operator token (`Authorization: Operator <token>` per `docs/OPERATOR.md` / runbook); if no operator token is configured the whole `/api/operator/*` surface falls through to 404, and a wrong token answers the same 404 as an unknown path. **There is no operator restore/unarchive route** — the routes table registers archive only.
- #4123 itself: `gh pr view 4123` read 2026-10-28 — state **MERGED**, merged 2026-10-18T14:45:05Z, head `dfbea66a3fc073a6723bf6855998063b4bd89c1b`, title "Restore message integrity and expose guarded operator archiving". Its own synthetic Worker fixture: 3,000 messages, projection 1,133,960 → 189,796 bytes. Local fixture result, not a production measurement (PR body says so).

**Automatic driver (same door, no human)**

- `server/store-relief.mjs` — `relieveProjections` / `relieveProjectionsIncrementally`: the store-growth job (`server/jobs.mjs`, ~line 669) drives the operator door for rooms past the 3.5 MB line, largest first, ≤3 rooms per tick, `keepNewest` 2000, and **only** while the caller hands it a verified recovery point (newest verified daily backup, ≤24 h old per `docs/OPERATOR.md`); with none it archives nothing and reports `backupMissing: 1`. Parked (backfill-blocked) rooms archive in `belowCursor` mode.
- `docs/OPERATOR.md` (~lines 64–69) is the operator contract of record: dry-run shape, certification refusals, audit rows, the relief gate, the restore function, and the warning "Do not run `store.rehydrateAllProjections()` on an archived room".

**Member read paths (the surfaces this pack mostly instructs)**

- `server/store.mjs` `snapshot(token, roomId, …, view = "full", …, messageLimit = null)` (~line 4790) — **at main there is no `fullHistory` parameter**. Behaviour at main, read directly: if `messageLimit !== null`, it returns `repository.recent(messageLimit, visible)` plus `messagesWindow { mode: "recent", limit, omitted: countViewerVisible − returned, older: "conversation" }`; if `messageLimit === null` **and** `room.state.messagesArchive` is set, it falls into `messages = [...repository.records()]` — the full archived history, materialised on every such call. If neither, it returns the projection messages by reference.
- `server/snapshot-window.mjs` — the browser/REST/MCP window layer added after #4265's base: `SNAPSHOT_WINDOW_MESSAGES = 100`, `SNAPSHOT_WINDOW_BYTES = 30 * 1024`, message budget 22 KB; `readRoomSnapshot(...)` calls `store.snapshot(..., windowed ? SNAPSHOT_WINDOW_MESSAGES : null)` and adds `messagesPage { before, hasMore }`; `readMessagePage(...)` serves older pages — and at main it builds the page by iterating **all** of `repository.records()` filtered for the viewer, then slicing (see §2.3).
- `server/http.mjs` bare room GET (~line 4420s) — default and `?messages=recent` are the windowed read; `?full=1` is retired: 422 `invalid_snapshot_view` ("The full room read is retired. Read the window, then page older messages.") unless `ROOM_SNAPSHOT_FULL_COMPAT=1`, in which case it is the non-windowed `store.snapshot()` call above.
- `server/routes/room-window.mjs` — `GET /api/rooms/{roomId}/bootstrap` and `GET /api/rooms/{roomId}/messages?before=&limit=` (≤100/page), parity-noted in the route table.
- `server/conversation-sync.mjs` — `readConversation` / `archivedConversationRows`: conversation pages over archived history use the message repository in descending order and stop at `limit + 1` rows; DM visibility, history floor (PRIV-2), and channel filters applied per row.
- Archived history is reachable from the other readers today, by design: search (`server/store.mjs` search merges `archivedMatchingRecords(...)` first — "Archived messages are not in the projection; they are older than every projected message, so they come first"), threads (`archivedThreadRecords`), single-message lookup (`archivedMessageRow`, `archivedDmPartiesReader`), and export (`docs/OPERATOR.md`: "search, threads and exports still read them").
- Client: `src/client.js` — `windowOmitted` is captured from `messagesWindow.omitted` (~line 386); `backfill()` (~line 546) walks `/conversation` and accepts the older segment **only if it is exactly `windowOmitted` long** and id-disjoint from the held window, otherwise returns false and the legacy path takes over; `pageOlder()` (~line 668) pages `/messages?before=` up to 40 pages per gesture; `loadHistory()` (~line 457) is the reader-gesture entry; `src/app.js` (~line 4486) calls `client.loadHistory()` on scroll-up. **No client code at main reads `state.messagesArchive`** (grep over `src/` at main: zero hits outside the lifecycle `room.archived` handling) — the marker rides the projection but is invisible to members (§2.4).

**The bound snapshot leg (#4265) — read at its bound head `156eb4b0`**

- `store.snapshot(..., messageLimit = null, fullHistory = false)`: on an archived room with no limit and no opt-in it returns **the live window only** (`room.state.messages` as held), plus `messagesWindow { mode: "recent", limit: <live count>, omitted: repository.countArchivedForViewer(viewer, floor), older: "conversation" }`; `fullHistory: true` returns `[...repository.records()]` byte-for-byte as the legacy form; `fullHistory` together with a limit refuses 422 `invalid_snapshot_view`. The HTTP door at that head passes the opt-in for its bare form (`!recentMessages`); MCP `room_read_board` at that head takes the new default.
- PR #4265 body (read via `gh pr view 4265`, 2026-10-28) carries the archived-shape probe: pre-fix default snapshot median 3,825 ms at 23k archived (live window 2,000) → post-fix 127 ms; 937 ms → 144 ms at 10k archived; post-fix flat in archive depth; the opt-in's message-id list hash equals the pre-fix default's. `bench:room`'s fixture never archives, so the probe — not `bench:room` — is the S-1 evidence; the PR body records a `bench:room` no-regression table at its own base.
- Binding (read 2026-10-28 in `~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`, `prs."4265"`): bound head `156eb4b0f3dc769d1333bebe0c3edeea067ce3a0`, record `50cab6bc`, "SPILL-1 live-run gate leg (S-1: store snapshot stops materialising archived history by default). RECORD-MOVED to 156eb4b0 (SETTLE PASS 2, 2026-10-26) superseding 6eab23b0; REBIND-WITH-NAMED-RED: unit red = exactly main's 3 manifest-drift tests. Lands only in the SPILL sequence with #4247 and #4256, singly. bench:room owed before landing; Proof 3 owed at acceptance." Flag `FLAG-SPILL1` (kind `merged`, pr 4265) discharges on its merge; `SPILL-LEGS-COMPLETE` needs #4265 + #4256 merged (with #4247, the record legs are complete; the first live SPILL-1 run still needs the S3 arm — that arm is #4247's job, not this piece's).
- Settle order of record: `~/workspace/wave-2026-10-27-settle-pass-21/SYNTHESIS.md` §"Storage chain: #4900 → #4543 (trigger check) → #4265"; settle pass 2 (`~/workspace/wave-2026-10-26-settle-pass-2/SYNTHESIS.md`) records #4265 REBIND-WITH-NAMED-RED via RECORD-MOVED, record `50cab6bc`, "bench:room + Proof 3 still owed".

---

## 2. Current state

### 2.1 The manual operator run still waits on John — but production already has an archived room

- The runbook's manual run — Phase S / S2 in `~/workspace/fixplan-2026-10-19/operator-session-runbook.md` ("S2 — The #4123 door run at the max room") — is an operator-session act: it needs the operator token from John's custody file and a largest room named by the runbook's Phase B/S1 identity read. It has not been run as a manual sitting act on file. Expected result per runbook S2 step 2: `projectionBytes.after` in **roughly 0.6–0.9 MB** for a ~3.55 MB room at `keepNewest` 2000 (fixture measurement −73.4%: 3,500,932 → 930,518 B, sourced there to PR #4247's body).
- **Correction to the naive reading of that gate:** the archive does not only happen by hand. Executed evidence: `~/workspace/wave-2026-10-24-200/storage-spill/SYNTHESIS.md` records that at **2026-10-25T07:30:41Z** the store-growth job's relief leg archived the largest production room through this same door — `reliefAttempted 1 / relieved 1 / refused 0 / reliefFreedBytes 2,814,618`, `maxProjectionBytes` 3,807,861 → **1,005,626 B** (agreeing reads 07:43–07:54Z, lanes 15/18). Why that tick succeeded after refusing at 03:30Z is recorded there as **UNVERIFIED**. Consequence: at least one production room has carried a `messagesArchive` marker since 2026-10-25, so the member-facing archived-room experience is **already live in production**, not a future event gated on John's sitting. Which room(s) and the current marker count at 2026-10-28 are **UNVERIFIED** (no operator read was run by this lane; no shipped door names a largest room — storage-spill lane-21 C15).
- Latest gauge on file (MEMORY.md, 2026-10-28): largest room **1,433,781 B**, +302,963 B day-over-day (~303 KB/day, ~3× the prior rate); ~7.8 days to the 3.8 MB BUY-TIME trigger and ~9.1 days to the 4 MiB cap at that rate. The cap problem recurs on a weekly timescale; relief/archiving is a recurring event, not a one-off.

### 2.2 The bare-snapshot cost is still on main (#4265 unlanded)

- `gh pr view 4265` (2026-10-28): state **OPEN**, head exactly the bound `156eb4b0…`. Until it lands, the §1.2 main behaviour stands: a non-windowed `store.snapshot()` on an archived room materialises the entire archived history. At main the only HTTP caller that can reach that path is the compat `?full=1` read (`ROOM_SNAPSHOT_FULL_COMPAT=1`); the windowed browser read does not. The exposure is therefore narrower than at #4265's base but the store-level rule the PR establishes — default = live window, full history only behind an explicit opt-in — does not exist at main.
- #4265's caller inventory is **stale at main** (its base predates the window layer): its body names `server/mcp-full-profile.mjs` `room_read_board` as an unlimited-form caller; at main `aaa749065a` that profile calls `store.snapshot(secret, roomId, null, "work")` (~line 362), which returns before the messages branch, and the windowed caller is `server/snapshot-window.mjs` (~line 131). Any landing/port that copies the PR's http/mcp edits verbatim will fight main's newer architecture. This is an instruction input, not a defect in the bound record.
- Its SPILL-sequence partners are not in a landable state as filed: `gh pr view 4247` (2026-10-28) — state **CLOSED**, head `4a82fa3104413612a10200ced718f2120dddc787`; `gh pr view 4256` — state **CLOSED**, head `47fbb1858c3b00872e0407ab9cf474d0b44ce150`. The binding still says #4265 "lands only in the SPILL sequence with #4247 and #4256, singly". #4247's reopening is John's gate (MEMORY.md: "#4247 was CLOSED in the 2026-10-25 cleanup; reopening is John's gate"). The sequencing disposition is therefore owed by the coordinator/seat before #4265 can land; this pack does not relitigate it (§4 Step 0).

### 2.3 Paging older history still pays archive-depth cost at main

- Fresh read at main `aaa749065a`, `server/snapshot-window.mjs` `readMessagePage()`: it materialises `visible = []` from **every** record in `repository.records()` (viewer-filtered), computes seqs for all of them, then slices one ≤100-message page. On an archived room each "load older" page costs O(total history), the exact shape #4265 removes from `snapshot()` but does not touch here (its named follow-up S-4: the remaining archive walks "still re-parse `retainedIds` via `json_each` per page" and "belong to explicit full-history consumers" — the member page read is now such a consumer and is member-facing, so this pack promotes it from follow-up to instructed work, §4 Step 2).
- `src/client.js` `backfill()` compounds this on the client: it accepts a `/conversation` backfill only when the segment length equals `windowOmitted` exactly. On a room archived at `keepNewest` 2000 with, say, 23k archived, `omitted` is in the tens of thousands; a single failed contiguity proof discards the walk (bounded at 1,000 pages / 3 resets) and returns false. Whether the browser's primary older-history path in production today is `pageOlder()` (post-window-layer) or `backfill()` depends on held-state shape — **UNVERIFIED** by this lane; both paths are instructed defensively in §4 Step 3.

### 2.4 Members get no signal that archiving happened — and no wrong signal either (yet)

- Verified by grep at main: no client code reads `messagesArchive`; `messagesWindow.omitted` is consumed only as an internal fill counter (`src/client.js` `windowOmitted`). There is no divider, notice, count, or settings line anywhere in `src/` for message archiving. The room simply appears to have deep scrollable history — which is the correct default (§3) — but three honesty gaps follow:
  1. **The owner is never told.** Relief or an operator run can archive a room with the only record in `operator_actions` (operator-only surface). No room event, no owner-visible line, nothing in room settings states that N older messages are archived or that a restore path exists.
  2. **Failure looks like loss.** If paging/backfill fails partway (§2.3), the member's visible history just stops. Nothing distinguishes "this is the start of the room" from "older messages exist but could not be loaded" — on an archived room that reads as deleted history.
  3. **The cap copy lies by implication** (§2.5).

### 2.5 Misleading cap copy

- `server/store.mjs` (~lines 3585, 4525, 6286): 409 `pilot_limit` tells the member "Ask the room owner to have older messages archived to free space." The owner cannot: the only doors are the operator token (`POST /api/operator/archive`) and the automatic relief job. The errors catalogue (`skills/project-room/references/errors-catalog.md`, `pilot_limit` row) says "Ask the room owner to raise the limit" — a third, also-wrong instruction. Copy-only defect; the error code and status must not change.

### 2.6 No operator undo

- `restoreArchivedMessages` exists and is parity-tested (`tests/operator-archive.test.js`; `cloudflare/operator-archive.check.mjs` per runbook S2 step 5), but there is no operator route for it (runbook: "a restore is a fleet code act arranged with Jill after the session, not a command in this sitting"). Any member-facing work in this pack must not promise an undo button.

---

## 3. What fantastic means

A member of an archived room cannot tell where the projection ends and the archive begins, except for one honest line when it matters; the room never slows down as the archive deepens; and the owner can see that archiving happened and that nothing was lost.

Concrete end state, with the numbers that prove it:

1. **Flat open.** Opening an archived room (fixture: 23,000 archived, live window 2,000, `keepNewest` 2000) costs the same as opening it the day before archiving: windowed payload ≤ 30 KB / ≤100 messages (the existing `snapshot-window` budgets), and the store-level default snapshot on the archived fixture is **flat in archive depth** — median at 23k archived within 1.5× of median at 10k archived, and ≤ ~150 ms on the #4265 probe's hardware class (probe post-fix: 127 ms @23k, 144 ms @10k; pre-fix 3,825 ms @23k is the failure shape). No code path a member can trigger — open, scroll, search, thread, deep link — materialises the full archived history by default.
2. **Every message reachable, in bounded steps.** Each older-history page is ≤100 messages, fetched in one request whose server cost is bounded by the page, not by archive depth (page-request server time at 23k archived within 1.5× of the same request at 2k archived). Scrolling from the live window to the first message of the room takes ⌈archived ÷ 100⌉ page loads and zero dead ends; a search whose only hit is an archived message returns it; a thread rooted in an archived message opens; a deep link to an archived message lands on it.
3. **Nothing looks deleted.** The full-history opt-in's message-id list hash for a fixture room equals the pre-archive default's (the #4265 correctness anchor, kept). Export of an archived room contains the archived messages (already true at main; must stay true — §5 A5).
4. **One honest line, ≤20 words, shown once at the seam.** When a member paging upward crosses from the live window into archived history, the timeline shows one divider, e.g. "Older messages were archived to keep this room fast. Everything is still here." (exact copy in §4 Step 3). It appears at most once per room per session, never as a banner over the room, and never with the word "deleted". A separate failure state exists: if older history exists (`messagesWindow.omitted > 0` or `messagesPage.hasMore`) but a page load fails, the timeline top shows a retry affordance saying older messages could not be loaded — never a silent stop that impersonates the start of the room.
5. **The room stays live, visibly.** Composer enabled, posting works, no read-only note, no "Archived" badge in the switcher for a message-archived room (those belong exclusively to the lifecycle archive). Zero shared copy strings between the two archive kinds.
6. **The owner can see it.** Room settings/about shows one line when the room carries an archive marker: "⟨N⟩ older messages archived · room stays live · history, search and export unchanged" with N = the marker's `count`. That is the whole owner surface: no owner archive button (the door is operator-only), no owner restore button (§2.6).
7. **Operator truth unchanged.** A manual or relief archive still lands the room in the expected band (for a ~3.55 MB room at `keepNewest` 2000: **0.6–0.9 MB** after, per runbook S2), still plan-bound (`plan_changed` on drift), still audit-rowed, and the post-run member readback (§4 Step 5) passes on the actual archived room.

Exemplars to match: the seam-invisibility of Slack/Discord infinite history (archiving is a storage fact, never a user-facing event), and this repo's own lifecycle note (`#room-archived-note`) as the **copy register** to mirror — one factual sentence, date/count, what still works — while keeping the two archives' wording strictly separate.

---

## 4. The instruction

Order matters. Steps 1–2 are server work that must not duplicate #4265; Step 3–4 are client; Step 5 is the post-archive verification ritual that runs whenever production archiving happens. Vanilla JS only; no new tables; no schema change; no new event types.

### Step 0 — Preconditions and forks (no code)

1. Read the binding for #4265 fresh (`landing-watch-bindings.json`, `prs."4265"`) and `gh pr view 4265`. If #4265 has landed at its bound head (or a RECORD-MOVED successor), skip Step 1's port and go to Step 2. If it is still open, Step 1 is a **merge-up + port**, not a fresh implementation and not a verbatim cherry-pick (§2.2).
2. **FORK (landing order, not John's product decisions):** the binding conditions #4265's landing on the SPILL sequence with #4247 + #4256, both currently CLOSED, and #4247's reopening is **John's gate**. The implementer does not resolve this. The lane's deliverable is the composed, green, ready-to-land head plus a one-line note to the coordinator naming the fork; landing waits for the seat's disposition. Neither of John's two pending wave-level decisions (verified-delivery vocabulary; sponsor human surface) touches this piece — no fork on either.
3. If a production manual archive is wanted before Step 1 lands: it is John's operator session (runbook Phase S), unchanged by this pack. Do not build any substitute door.

### Step 1 — Port #4265's store rule onto current main (server; only the part #4265 owns)

Target: `server/store.mjs` `snapshot()` at the composed head.

1. Re-run #4265's caller inventory **at the composed head** and write it into the PR body before editing. The inventory at main `aaa749065a` is: `server/snapshot-window.mjs` `readRoomSnapshot` (windowed: passes `SNAPSHOT_WINDOW_MESSAGES`; non-windowed: passes `null`), `server/mcp-full-profile.mjs` and `server/mcp-room-profile.mjs` (both `view: "work"`, return before the messages branch), the compat `?full=1` HTTP read (the only non-windowed HTTP path). If the composed head differs, the fresh inventory governs.
2. Add the opt-in exactly as bound: `snapshot(..., messageLimit = null, fullHistory = false)` as the last parameter. Semantics, no deviations:
   - `fullHistory` non-boolean, or `fullHistory: true` with `messageLimit !== null` → 422 `invalid_snapshot_view` (existing code; catalogue row already exists — no new error code).
   - Archived room, no limit, no opt-in → live window only: return `room.state.messages` as held, with `messagesWindow { mode: "recent", limit: <live count>, omitted: <viewer-visible archived count>, older: "conversation" }`. The omitted count must be the SQL count from #4265 (`countArchivedForViewer` on the message queries, with the targeted-DM rule and the PRIV-2 history floor pushed into SQL), **not** a `records()` walk and not `countMetadata`'s paged walk.
   - `fullHistory: true` → `[...repository.records()]`, byte-for-byte the legacy form.
   - Un-archived rooms: unchanged in every branch (no window marker added where none existed).
   - Port #4265's S-6 seq-cache change only if the composed head does not already carry an equivalent (check `server/message-queries.mjs` at the composed head first; duplicate caching is a defect).
3. Wire the opt-in at exactly the callers the fresh inventory names as full-history consumers. At main's shape that is: the non-windowed branch of `readRoomSnapshot` passes `fullHistory: true` (its contract is the export-compatible full read), and **nothing else** — the windowed branch, bootstrap, and both MCP profiles take the new default. Do **not** resurrect #4265-base's `server/http.mjs` caller edit; at main the HTTP door goes through `snapshot-window.mjs`.
4. Keep #4265's tests, adapted to the composed head: `tests/snapshot-recent-messages.test.js` (store default = live window on an archived room; opt-in returns identical full history; conflicting selectors refuse) and `tests/message-storage-boundaries.test.js` (count equivalence across viewers × floor shapes vs `countMetadata`; seq-cache keying). The pre-existing post-compaction full-history test must pass via the explicit opt-in, not via a default.
5. Land discipline for this step: it is the bound PR's own landing — singly, in the SPILL order of record (#4900 → #4543 trigger-checked → #4265), green at the exact composed head, `ready-to-land` label before heavy CI, Ruling 41 evidence rules. `bench:room` (owed per binding) and the archived-shape probe (§5 A2) are both filed in the PR before it is called ready.

### Step 2 — Bound the member page read (server; new work, not in #4265)

Target: `server/snapshot-window.mjs` `readMessagePage()` and, if needed, `server/message-repository.mjs` / `server/message-queries.mjs`.

1. Replace the materialise-everything-then-slice body with a bounded repository read: records in descending seq order, strictly older than the `before` seq cursor, viewer-filtered (DM rule + PRIV-2 floor) **in the query**, stopping at `limit + 1` visible rows. If the repository cannot express that today, add one method (suggested name `pageBefore(viewerId, floor, beforeSeq, limit)`) beside the existing `recent`/`records`/`countViewerVisible` methods in `server/message-queries.mjs`, mirroring `records()`' visible-SQL floor encoding including same-instant exclusions — copy the encoding from the existing code, do not invent a second one.
2. Response contract is frozen: `{ messagesVersion: 1, roomId, sequence, messages, messagesPage: { before, hasMore }, viewerId, viewerAccountId, viewerAuthEpoch, viewerSessionBinding, viewerSessionRevision }`, messages chronological, `before` = seq of the oldest returned message, `hasMore` true iff older visible messages remain. Redaction (`redactMessageTree`) and the 22 KB newest-fitting byte budget behave exactly as at main.
3. The `/conversation` path (`server/conversation-sync.mjs`) already bounds its archived read (descending, stops at `limit + 1`) — do not rewrite it; only verify it against the §5 fixtures.
4. Add a test that proves boundedness, not just correctness: on the 23k-archived fixture, instrument or count repository rows materialised per page request (the suite may assert on a counter the repository already exposes, or on wall-time ratio vs the 2k fixture — use rows if a counter exists, time-ratio otherwise, and say which in the PR).

### Step 3 — The member-facing seam (client, vanilla JS)

Targets: `src/client.js`, `src/app.js`, and the UI-text catalogue the touched strings live in (find the `uiText(...)` source for neighbouring timeline strings and add keys there; do not hardcode English in `app.js` if the neighbouring code goes through `uiText`).

1. **Expose the marker, minimally.** In `readRoomSnapshot` (server, `server/snapshot-window.mjs`), when the room carries an archive marker, add one member-safe field to the windowed response: `messagesArchive: { count: <marker count> }`. Nothing else from the marker crosses the wire — never `retainedIds`, never `throughSeq`. (This is a response-shape addition to an existing route, not a new route; see §5 sweep notes.) Un-archived rooms: field absent.
2. **Boundary divider.** In `src/app.js` timeline rendering: when the held history crosses the archive boundary during paging — concretely, when a `pageOlder()`/`backfill()` merge first brings in a message older than the live window on a room whose snapshot carried `messagesArchive` — render one divider element at that boundary with exactly this copy: **"Older messages were archived to keep this room fast. Everything is still here."** Once per room per session (a flag on the client session object, reset on room switch); not rendered on initial load if the boundary has not been crossed; not rendered at all on un-archived rooms. Give it a stable hook (`data-archive-divider`) for tests.
3. **Failure is not the floor.** Where the timeline currently just stops at the oldest held message: if (`messagesPage.hasMore` or `windowOmitted > 0`) and the last older-page attempt failed, render a retry row at the timeline top — copy: **"Older messages could not be loaded."** + a "Try again" button that re-invokes `client.loadHistory()`. On success it removes itself. This row and the §3.2 divider are mutually exclusive at any moment.
4. **Do not touch:** composer state, the lifecycle `#room-archived-note`, the room switcher, channel archive UI, `isRoomArchived` anywhere. A message-archived room must produce zero changes in `syncRoomLifecycle()` output.
5. Client tests: extend `tests/client-lazy-history.test.js` (divider appears exactly once across two page merges; retry row appears on a failed page and clears on success; no divider on an un-archived fixture) — follow that suite's existing harness shape.

### Step 4 — Owner line + cap copy (small, exact)

1. Room settings/about (`src/app.js`, the room-about surface that hosts `#room-archive-button`): when the current snapshot carries `messagesArchive`, render one line under the room facts: **"⟨count⟩ older messages archived · this room stays live · history, search and export are unchanged."** Count from the Step 3.1 field, formatted with locale grouping. No button, no link, no date (the marker carries no date — do not fabricate one).
2. Cap copy: in `server/store.mjs` replace all three `pilot_limit` texts with: **"Room projection limit reached; no data was changed. Older messages must be archived by an operator before this room can grow."** — and update the `pilot_limit` row in `skills/project-room/references/errors-catalog.md` to match, then run `node scripts/skills-sync.mjs` so the `plugins/` mirror stays byte-identical. Error code, status (409), and refusal behaviour unchanged. Grep the test tree for the old strings before landing and update only pins of the old copy, naming them in the PR.

### Step 5 — Post-archive member readback (ritual; runs after any production archive, manual or relief-observed)

After any production archive event affecting a room (John's S2 execute, or a store-growth tick reporting `relieved ≥ 1`), the verifier (John's Tab or Jill's fleet, §6) runs this readback on the affected room within the same day, in a real member session:

1. Gauge pair: execute response `projectionBytes { before, after }` (or the tick's `reliefFreedBytes` + `maxProjectionBytes`) — `after` in the expected band for the room's size (0.6–0.9 MB for a ~3.55 MB room at keep 2000).
2. Open the room: live window renders, composer enabled, no lifecycle banner.
3. Scroll to the top: divider (§3.2) appears once; continuing reaches messages dated before the archive's `throughSeq` era — pick the oldest reachable message and note its id.
4. Search for a term known to occur only in an archived message (choose from the room's own pre-archive history): hit returned, opens in place.
5. Open a thread rooted at an archived message; follow a deep link to an archived message id.
6. Export the room; confirm the §5.3 message id is present in the export.
7. Marker-vs-table agreement (the storage-spill lane-15 V6 "silent-lie" check): the marker's `count` equals the archived rows count for the room, read via the operator status/store read available to the verifier — if no member/operator surface can make this read, record the check as UNPROVEN rather than passed (per storage-spill SYNTHESIS §"Post-run verification": gauge + job summary alone do not sign off an archive).

Any failure at 3–6 is FAIL-DATA territory: stop, do not re-archive, and escalate to Jill — the restore path is `restoreArchivedMessages` as a fleet code act (§2.6), never an improvised production write.

### Explicit non-goals

- No unarchive/restore route or UI. No owner- or member-initiated archiving. No change to `keepNewest` defaults, the 3.5 MB relief line, the backup gate, or the 4 MiB cap (#4543's trigger-gated 5 MiB raise is its own bound PR — do not fold it in). No #4247 SPILL-1 job work and no S3 arm (`ROOM_MESSAGES_ARCHIVE_LIVE`) — #4247 is closed and its reopening is John's gate. No schema change, no new tables, no new event types, no money surfaces. No lifecycle-archive or channel-archive changes. No client framework work (vanilla JS, convergence path only).

---

## 5. Acceptance

The coordinator/Jill accepts from this section alone. All commands run at the composed head in a `git archive` tree or the implementer's worktree with `TMPDIR` pointed at the lane scratch.

**A1 — Bound-leg fidelity (Step 1).** `node --test tests/snapshot-recent-messages.test.js tests/message-storage-boundaries.test.js` green; grep the composed `server/store.mjs`: `fullHistory` present as `snapshot()`'s last parameter; the archived default branch contains no `repository.records()`; the limit+opt-in branch refuses 422 `invalid_snapshot_view`.

**A2 — Archived-shape probe (Step 1, the #4265 evidence shape).** Build fixtures through the real `RoomStore` replay path with `archiveMessages` at `keepNewest` 2000, at 10k and 23k archived (the PR #4265 probe shapes). Pass iff: default snapshot median at 23k ≤ 1.5× median at 10k; `fullHistory: true` message-id list hash equals the pre-change default's hash on the same fixture; bounded (`messageLimit`) `messagesWindow` values unchanged vs main. File the table in the PR. Plus `npm run bench:room -- --base origin/main --sizes 1000`: no metric verdict worse than "~" (the binding's owed bench).

**A3 — Page boundedness (Step 2).** `node --test tests/room-speed-read.test.js tests/conversation-sync.test.js` green, plus the new boundedness test from §4 Step 2.4: rows materialised per `/messages` page on the 23k fixture ≤ 2× the rows on the 2k fixture (or the time-ratio variant, as filed). Response-shape diff vs main on an un-archived fixture: byte-identical JSON keys.

**A4 — Operator door regression (untouched, prove it).** `node --test tests/operator-archive.test.js tests/operator-archive-below-cursor.test.js tests/operator-archive-event-cap.test.js` green; dry run on a fixture room returns `archived/retained/freedBytes/throughSeq/projectionBytes/expect`; a real run with a stale `expect` refuses 409 `plan_changed`; a `restoreArchivedMessages` round-trip is deep-equal (existing parity assertions).

**A5 — Reachability (Steps 2–3 fixtures).** On the 23k-archived fixture room, through the HTTP doors: search for an archived-only term returns the hit; `messageThread` on an archived root returns the thread; `GET /conversation` pages reach the oldest message; `node --test tests/room-export.test.js` green and the fixture export contains an archived-only message id.

**A6 — Member seam (Steps 3–4).** `node --test tests/client-lazy-history.test.js tests/client-delta-sync.test.js` green including the new cases: exactly one `[data-archive-divider]` after crossing the boundary, zero on an un-archived room, retry row on failed page + clears on success, settings line present with the exact count when the marker field is present. Negative checks, by grep + fixture render: composer not disabled, `#room-archived-note` hidden, no "Archived" badge — on a message-archived (not lifecycle-archived) room. `pilot_limit`: grep `server/store.mjs` and the errors catalogue for "Ask the room owner" — zero hits; the 409 refusal itself still fires in the existing cap tests.

**A7 — Full close-out.** `npm run verify:affected` plus `CI=1 npm run check` (the change touches `server/**`), and the registration sweep (`node ~/workspace/fleet-tools/registration-sweep.mjs --range <base>..<head> --repo-dir <checkout>`) with no MISSING. Sweep items for this change:
- Runtime-package closure — **applies if** Step 2 adds a `server/**` module: add it (with import closure) to `scripts/runtime-package.mjs` **and** `scripts/candidate-runtime-fixture.mjs`. (At main `server/operator-archive.mjs` is already registered, runtime-package ~line 374.) If no new module: n/a — no new module.
- Error-code catalogue, both copies — **applies**: `pilot_limit` copy changes (§4 Step 4.2) → `skills/project-room/references/errors-catalog.md` + `node scripts/skills-sync.mjs` mirror check. No new error code is created; `invalid_snapshot_view` already has a row.
- Route triple — **n/a if** Step 3.1 stays a field on the existing windowed response (then still update that operation's description in `docs/openapi.yaml` and note it in the PR); **applies in full** (table.mjs + openapi + parity note) if the implementer adds any route — which §4 does not instruct.
- Harness copy sets — **applies**: `src/client.js` / `src/app.js` changes must be checked against every test-harness copy/re-point set that transforms client sources (sweep item 4); name the harnesses checked in the PR.
- Store registries — n/a: no new table, no schema change.
- Generated/mirrored artifacts — **applies**: skills-sync mirror (above); UI-text catalogue additions (§4 Step 3) regenerated/checked per that catalogue's own check; MCP catalog snapshot + count pins n/a — no MCP tool or EVENT_TYPES change (verify by grep: no diff under the MCP registry or event-type tables).
- Diff hygiene — if the composed diff exceeds 300 changed lines, the PR body carries `## Large diff justification:` (expected for Step 1's merge-up; write it at filing, not at acceptance).

**A8 — Production readback (Step 5, post-landing only).** After #4265 lands + deploys, or after the next production archive event, whichever first: the §4 Step 5 ritual executed on the affected room and filed with the seven items individually marked PASS / UNPROVEN / FAIL — a gauge-only sign-off is rejected per the storage-spill worst-case note.

---

## 6. Routing

- **Step 1 (port/merge-up of bound #4265): Codex** — server/core work at the store layer, and the composed head must be produced under the seat's claim discipline from John's Mac side. Handover: `room_request_reply` to Codex's room member with a concrete ask, the `workItemId` for this pack, and the expected result named as "composed #4265 head, green, A1+A2 evidence filed in the PR, ready for the seat — landing itself waits on the §4 Step 0.2 SPILL-sequence disposition". All Codex utilisation inside Project Room, per the settled constraint.
- **Step 2 (bounded page read): Codex** (same work item or its immediate successor; server read-path).
- **Steps 3–4 (client seam, owner line, copy): Claude** — client surfaces and copy are his train; vanilla JS only. Handover: his own PR, referencing this pack's §4 Steps 3–4 verbatim copy strings; Jill's fleet reviews against A6.
- **Landing: Grok Bot (landing seat), with John's Tab** — #4265 lands singly, in the storage order #4900 → #4543 (trigger-checked) → #4265, only after the Step 0.2 fork is dispositioned (seat/coordinator; #4247 reopen is John's tap if the seat rules it necessary). Steps 2–4 land as ordinary small-change-tier PRs after Step 1, batched per Rules v2 (they are non-money, non-shared-core; Step 2 touches a shared read path — if the seat classes `snapshot-window.mjs` as shared-core, it lands singly too; the seat decides, the pack does not).
- **Verification: Jill's fleet** (A1–A7 at the composed heads; never merges) and **John's Tab** for the A8 production readback after the next archive event; **Fo** on responsive duty if A6's client suites implicate the browser shards.
- **John's own gates touched by this piece** (named, not decided here): the operator session for any manual S2 run and for any production restore; reopening #4247 if the seat's SPILL-sequence disposition requires it. Everything else in this pack is delegated work.

---

*Sources read for this pack: BRIEF.md (wave master brief); main `aaa749065a6451321a949ddcb923f3174504fe35` via `git archive` (`server/store.mjs`, `server/operator-archive.mjs`, `server/operator-routes.mjs`, `server/messages-store.mjs`, `server/store-relief.mjs`, `server/snapshot-window.mjs`, `server/routes/room-window.mjs`, `server/http.mjs`, `server/conversation-sync.mjs`, `src/client.js`, `src/app.js`, `docs/OPERATOR.md`, errors catalogue); bound head `156eb4b0` via `git archive` (`server/store.mjs`, `server/http.mjs`); `gh pr view` for #4123 (MERGED), #4265 (OPEN, bound head), #4247 (CLOSED), #4256 (CLOSED); bindings file `prs."4265"` + FLAG-SPILL1/SPILL-LEGS-COMPLETE; settle-pass-21 SYNTHESIS (storage chain), settle-pass-2 SYNTHESIS (#4265 record), storage-spill SYNTHESIS (2026-10-25 relief execution + post-run verification spine), operator-session-runbook Phase S/S2 (0.6–0.9 MB band, restore truth).*
