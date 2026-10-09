# What is NOT proven

Explicit limits of this deliverable. Gaps are listed, not hidden.

## Not proven

1. **The patches are not landed.** They are verified on scratch copies of the
   SDK only. `wave2000/guild-22` still ships the five bugs. Landing needs the
   SDK owner / Dot / John, plus updating guild-22's stale test
   (`test_rooms.py::test_reply_pins_thread_root` asserts the old `parentId`
   payload — see README).

2. **Fixtures are hand-built from source reads, not captured from live
   traffic.** Every shape was verified against server source at
   `origin/main` `97f4edf26` and spot-checked against a live muse-room event
   page (which confirmed the `{sequence, event}` envelope), but a live
   capture could carry fields the fixtures don't model (e.g. redaction
   markers, DM-scoped projections, certified-room indexed columns).

3. **No live-server integration test.** Offline by design (Dot's constraint).
   In particular these were NOT exercised against a running server:
   - the real 422 `Unexpected field: parentId` on a reply post (proven from
     the `shapes` allowlist + `validateCommand`, not from a live 422);
   - the real 409 `idempotency_conflict` on a same-id/different-payload retry
     (proven from the fingerprint code; the test uses a fake implementing the
     documented rule);
   - `iter_events` against a real filtered log (proven from the
     `eventsAfter` cursor comments; the test uses scripted pages).

4. **Only the five mismatches are addressed.** The rest of the SDK surface is
   NOT contract-verified: claims write field shapes beyond the read path,
   `work-claims/config` and `/status` payloads, the SSE `/stream` endpoint
   (not implemented by the SDK at all), DMs (`toMemberId`), guest-agent
   scope gates, rate-limit/`Retry-After` behavior, and the MCP surface.

5. **MessageRecord keeps legacy aliases** (`messageId`/`parentId` fallbacks).
   This is a deliberate tolerant-reader choice (the saved-messages view does
   use `messageId`), but it means a future server rename would parse silently
   instead of failing loudly. The fixtures pin the canonical names.

6. **The 10,000-page guard in `iter_events` is arbitrary.** It bounds a
   runaway client; it is not derived from any server limit. A legitimate
   multi-million-event backfill would trip it — callers doing full backfills
   should page manually with `get_events`.

7. **Single-coordinator verification.** No second agent independently
   re-ran the proof (Dot's seq 8263 asks for strengthened independent
   contract proofs; this is one coordinator's pass). The negative control
   and the pinned SHAs make it re-runnable by anyone.

8. **Server drift.** The contract was sampled at `97f4edf26` (2026-10-09).
   If the server's envelope, shapes, or cursor semantics change, the
   fixtures go stale — there is no automated drift detector in this
   directory (that would be follow-up work, and it would need a live read
   path, which this mission excluded).
