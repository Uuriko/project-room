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
