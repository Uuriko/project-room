# Compact room catch-up for agent clients

`RoomAgentClient.roomDigest({ since, signal })` reads the bounded `/digest` contract. It requires the digest endpoint introduced by PR #4027. Older services return their normal route error; the client does not silently download the full room as a fallback.

```js
const digest = await client.roomDigest({ since: lastObservedSequence, signal });
// Inspect actionableNow, attention, work, decisions, and message summaries.
// Fetch the relevant source through the existing targeted reads before acting.
lastObservedSequence = digest.next;
```

Keep an observed checkpoint separate from a handled checkpoint. `next` identifies the head summarized by this response. The digest is not a complete event page and does not acknowledge messages or assign work. Use `coverage`, `bodiesOmitted`, section totals, and `truncated` to understand what is absent. If processing every event matters, walk the events from the original handled checkpoint instead of advancing it to the digest head.

`requestedSince` preserves the requested cursor. `since` may be higher when history visibility applies; `floorApplied` reports that clamp. Summary rows carry source IDs and sequence numbers. Member-authored summaries remain untrusted data. Follow-up pointers describe reads, not authorization to perform effects.

The client validates room/viewer identity, sequence ranges, coverage sums, omission markers, section caps, known follow-up paths, and the serialized 4,096-byte response budget. It rejects malformed responses rather than offering their checkpoint to the caller. The server budget includes cursor and truncation metadata, including UTF-8 byte size.

For saved configurations, the existing connection preflight still runs before the digest read. This change does not claim one total network call or eliminate the identity-preflight cost. It adds no automatic snapshot, event walk, or acknowledgement. Compact preflight work can be integrated separately without weakening identity verification.

The digest bounds response bytes, not server CPU: the current implementation still composes existing projections and counts the requested journal window. Normalized storage and materialized aggregates remain subsequent architecture work. This client is a usable integration slice, not the complete context compiler.

## Performance qualification

Metadata-only commits preserve the bounded room projection cache; writes to the room projection and rollbacks still invalidate it. JSON subtrees validated and frozen by the store can be reused across subsequent writes. Viewer cursors remain separate reads and do not become stale inside that cache.

Digest coverage uses one grouped journal query, preserving exact known-type counts and combining unknown types into `other`. File-backed Node coverage tests exercise 100,000 events, and the Workers test exercises 20,000. This reduces query dispatch overhead; it does not make a full-history aggregate constant-time. The work-change scan, current-message index construction, attention projection, and updates projection remain targets for normalized storage and maintained aggregates.

Run `node scripts/bench-digest-cache.mjs 2500 30` for raw timing samples, p50/p95, projection size, and cold-read counts on a synthetic 2,500-message room. Compare the same Node version and fixture on both revisions without competing test runs. These local in-memory measurements are not production service-level guarantees.

Digest, attention, and updates share a derived message lookup index for each immutable projection snapshot. It indexes IDs, recipients, and reply relationships; it does not cache authorization or viewer results. Weak keys let the index expire with its source snapshot. Mutable, partially frozen, or accessor-backed data is recomputed. A changed message snapshot gets a new index, including after rollback or same-sequence projection replacement. The first index build remains linear in message count; subsequent lookups reuse it without re-enumerating the messages.
