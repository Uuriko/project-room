# Bounded activation floor: original proposal and implementation status

Implementation checkpoint `0876eae5e`: v2 initializer/read/write/full audit, bounded existing-H activation stage, shared native-work-5 fence, existing recovery census comparison implemented. Composed44 Node and3 actual Native checks pass. Original proposal below remains the design record; its future-tense statements describe the pre-implementation contract, not remaining unsupported paths. No deployment or live format activation.

Original source checkpoint: `0410be7826d5c6552947cb1ac6d263b4c7ffc680`, invitation runtime `7b3a128eb00e1214ee6a6c810430f0d87348c3b6`. Redaction owner has released `normalized-current-v1-native-work-4` at `06af4213d`; do not independently invent a competing token.

## Reproduced defect

`tests/current-history-equivalent-instant.test.mjs` uses actual `readConversation` on a normalized room. A pre-join message at `2026-11-01T01:00:00+01:00` is the SAME instant as the join at `2026-11-01T00:00:00.000Z`, but leaks. `history-visibility.mjs` uses lexical timestamp comparisons; legacy `historyFloor` also collects ties with raw SQL string equality. Event validation accepts any Date.parse-compatible timestamp, preserving the original spelling. Neither SQL raw-at equality nor lexical ordering is a correct instant comparison.

## Exact visibility rule

Keep the existing distinction between message projection and event log. A message is visible iff its parsed creation instant is later than activation, or the instant equals activation and its ORIGINAL posting sequence is at least activation.sequence. A future arrival with an earlier timestamp remains hidden; a later event sequence alone never makes a backdated message visible. Sequence is ONLY the tie break. A pre-join message stamped in the future remains visible under the established timestamp-based message rule. Sequence-bearing event pages still require event.sequence >= activation.sequence and apply the target message's own visibility to edits/pins/reactions.

`messages-store.mjs` upsert preserves MIN(messages.seq, excluded.seq); current `messageWitness` binds sequence and entity hash. `readCurrentMessage` checks both. Therefore no numeric event-time projection or new timestamp index is necessary. A bare event uses its own exact event-ID point lookup for sequence. Keep message and event namespaces distinct: message IDs can differ from event IDs and channel copies have `:channel` suffixes. Do not guess by stripping suffixes or prefer an unrelated event whose ID happens to equal a message ID.

## Proposed protected representation

Use the EXISTING historyFloors domain, one activation record per member (including currently unlimited owner), not a new store/domain:

`{version:2, sequence:<latest absent/inactive->active sequence>, at:<exact original timestamp>, tieBreak:'source-sequence'}`.

No fake empty sameInstant set/count. No per-event registry. No eager exclusion enumeration. `historyExclusions` has no present records for v2, with its protected count exactly zero. Always keeping each member's activation supports later ownership/history-policy changes without needing to rediscover an unlimited owner's activation on an ordinary command. Current policy still determines whether the reader returns a limiting floor or null; the owner gains no new privacy exemption.

The runtime floor can expose separate addressed `messageSequence(id)` and `eventSequence(id)` methods under the shared read budget. Message sequence comes from existing protected messageWitness and must agree with the current canonical row already checked by readCurrentMessage. Event sequence comes from exact `(id,room_id)` lookup, with bounded scalar admission where appropriate. Missing/corrupt facts refuse; no silent visible fallback. Numeric timestamps are computed with Date.parse on bounded already-loaded strings, not persisted under an incompatible SQL parse contract.

## Writer and migration stitching

* initializeCurrentRoom derives all member activation tuples during the already code-owned initialization; qualify against actual history, not member.createdAt guesses.
* Existing normalized invitation append knows the exact event sequence/at. member.added/joined sets the new floor; inactive->active moves it; active permission changes leave it unchanged. Membership/link/burn/receipt/current proof/carrier remain in the existing transaction. Interrupted save rolls everything back; exact receipt retry returns without changing activation.
* Existing prepareCurrentWrite membership effects must preserve this activation record and count. Policy/ownership changes then need only protected addressed activation facts; no room-wide event scan at read/write time.
* Existing-H conversion currently REFUSES since_join at replay-cutover.mjs member stage. Add a finite bounded history activation qualification within existing conversion state/scratch: one source event page per advance, at most100 member activation entries, immutable witness/head binding. Reuse existing activation reducer and existing conversion units, not a new migration system. Stage resulting floor facts in the same protected metadata transition before publication. Do not claim existing-H support until this is actually qualified.

## Independent oracle and recovery

Independent test oracle parses timestamps and evaluates the rule above using original event order, without calling runtime history predicates. Cases include equivalent offset spellings, earlier/later instants whose strings sort incorrectly, late backdated arrivals, same instant before/after join, custom message IDs, channel copies, edit after join targeting a hidden message, removal/reactivation vs active permission changes, DM privacy, exact retry, cold reopen and fault rollback.

The full audit independently walks durable membership activation events and compares exact v2 floor records for ALL members and zero v2 exclusions. Existing bounded recovery census already accumulates per-member activation in its history scratch; compare that exact tuple directly for v2 instead of enumerating same-instant exclusion entries. Preserve its existing v1 compatibility branch; do not reinterpret old receipts. Recovery protocol/seal must bind the agreed shared serving format leaf. Coordinate this narrow census hunk with pairing owner before editing.

## Old-reader fence and rollout

This is an interpretation change. Old readers must refuse BEFORE seeing a v2 floor, rather than treating a missing sameInstantCount as an empty set. Root must choose the ONE coherent native-work fence together with released redaction native-work-4; helper must not independently reuse already-frozen token bytes or invent another concurrent token. No constructor/read DDL, automatic format upgrade, live mutation, grant or host/background permission change. Legacy unnormalized v1 history behavior is a separate compatibility branch; any lexical correction there needs its own explicit tests rather than silently changing it with the normalized representation.

This proposal is source-driven and unimplemented. The existing equivalent-offset reader red remains red until the full reader/writer/audit/recovery contract is agreed and implemented.
