# Attachment expiry partial-index qualification

Base: `2ebce68b3c556f313476716afdae84f2a2b33e6d`. Causal test checkpoint: `5cbad79a5`. Runtime cure: `fd26bc273`.

The original Native failure observed only the expiry UPDATE. The current no-expired-bytes fast path executes a SELECT and never that UPDATE, leaving its measured expiry cost undefined. Measuring the real SELECT exposed a genuine performance regression: its `state='staged'` condition omitted the exact live partial-index predicate. SQLite chose the room/message index and scanned terminal history even after the optional live index was installed.

The cure adds the logically redundant `state IN ('staged','committed')` predicate to that SELECT, matching the existing expiry UPDATE and quota query. It does not change expiration eligibility, schema, index inventory, permissions or operator admission.

Actual local Native Worker SQLite results:

| Query | Without optional index | With optional index after cure |
| --- | ---: | ---: |
| Expiry preflight physical adapter rows read | 520 | 12 |
| Quota physical adapter rows read | 520 | 12 |

Before the cure, accurately instrumented expiry was 520 before index installation and 521 after; the extra row is the first successful staging upload. EXPLAIN selected `current_room_attachments_message (room_id=?)` in both arms. After the cure it selects `room_attachments_live (room_id=? AND state=?)` in the installed arm. The fixture explains the actual captured production SELECT, and retains the >4x reduction assertion plus a <32 row bound.

The complete original Native test passes, including exact 32768-row / 4194304-key-byte / 67108864-stored-byte admission, all one-over refusals, receipt/storage fault rollback, install/reverse, cold restart and exact receipt retry. No boundary assertions were removed.

Targeted Node neighborhood: 29/29. Final preflight semantic assertion suite: 16/16 (overlaps the neighborhood). Actual Native: 1/1. Targeted ESLint: zero errors or warnings. Secret scan is recorded separately. Native timing is clock-only; row measurements are per-query DurableDatabase SQLite counters, not total stage cost or CPU. The cost fixture is genuine legacy serving state with all current database guards installed; existing normalized lifecycle tests separately cover guarded staged expiry and quota semantics. No production call, deploy or data mutation occurred.
