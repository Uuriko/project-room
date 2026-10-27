# Work authority: decision before the next storage cutover

2026-10-18. Target design decision, not a claim of completed migration.
Evidence: current `server/work-item-board.mjs`, selected work context and the
[existing migration census](WORKITEMS-BOARD-STEP0.md). The census already stopped
an unconditional workItems-to-board cutover because important state has no
lossless destination. A past plan or council label is not a substitute for the
current user's requirement to justify the design.

## Decision

Keep one canonical owner per kind of fact. A work item and an execution claim
are related but are not interchangeable records. Separate their persistence
without adding a third authoritative task system. Preserve the current work
semantics while replacing whole-room serialization only when a lossless contract
and migration proof are ready. The board becomes a composed view of these facts;
it must not independently invent task completion or acceptance.

| Fact | Target owner | What must not become a competing writer |
|---|---|---|
| Intent, definition of done, mode, assignment, task revision | Work aggregate, retaining existing work ID and behavior | Board card copies, summaries, caches |
| Workspace reservation, claim generation, expiry, holder | Existing claim authority | Embedded work claim as an independently mutable lease |
| Attempt identity, observed execution, stop/redirect acknowledgement | Existing execution/attempt lifecycle | Presence flags or task-state labels |
| Result identity, producer, content/version and withdrawal | Work result/evidence records | Presentation receipt or arbitrary agent assertion |
| Verification, decision and the exact result basis | Existing work acceptance transitions | Board display state or receipt existence |
| Help, handoff, blockers and successor links | Their existing domain records with explicit work links | Phantom task creation merely to preserve a UI link |
| Board arrangement and display metadata | Board presentation | Authority to change intent, permission or acceptance |

These are target ownership rules. Existing dual projections remain migration
liabilities until commands and readers are cut over; this document does not
pretend they already obey the target.

## Alternatives that must compete

- **Keep current whole-room work state forever:** rejected as endpoint. It retains
  full serialization and duplicated projections. Keep it temporarily as the
  semantic reference while migrating, rather than replacing it without parity.
- **Move every task field into board claims immediately:** rejected. The existing
  executable census demonstrates loss of briefs, roles, signed evidence and other
  lifecycle state. Fewer table names are not a correctness argument.
- **Add a fresh task/context/orchestrator store:** rejected. It adds another owner
  and another synchronization problem without resolving either existing model.
- **Preserve work semantics, normalize ownership and compose the board:** selected
  as the next candidate design. It reuses behavior and identity, limits migration
  novelty and permits old serializers/projections to be retired incrementally.
  It still must beat the reference on correctness and operation-specific cost.

## Executable cutover contract

1. Extend the existing field-fate census, rather than create another inventory.
   Each live field must be preserved under one owner, derived losslessly, or
   explicitly removed with its user-visible behavior and data consequences named.
2. Resolve each command to its owner. Mixed commands carry both work and claim
   generations and commit atomically where supported; stale mixed versions fail.
3. Prove equivalence on proposed/unclaimed, accepted/claimed, blocked/resumed,
   completed/reworked, superseded, expired/reclaimed and halted states.
4. Preserve current and historical result basis, signature references, independent
   verification, human decisions, withdrawal and privacy constraints.
5. Exercise commands through both work and board doors. A change through one door
   must be visible through the other without being overwritten by a later sync.
6. Measure one work mutation with increasing unrelated work/history. Normalize
   the existing aggregate only after baseline and writer/reader inventory exist.
7. Copy, compare semantic records, interrupt/resume, reverse and reopen. Only then
   remove the old writer and whole-room carrier. Do not ship a permanent dual owner.

## Scope discipline

No new public API, storage table, autonomous agent or dashboard is introduced by
this decision. Next implementation must be a lossless, measured cutover slice,
not blanket permission to build every row above. If simpler deletion or reuse
preserves the chosen user journey, prefer it and update the field-fate decision.
