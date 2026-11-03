# Bounded normalized work discussion

Base `b1058f18f5ff156b15b9f8cfab4f9930a14a198e`; runtime `a805d8b30` + own-work membership guard `8853f4e00`; qualification/registration `2439bdc1a`.

The friend Windows reproduction is causal: on the exact base, plain current-format task/exact-result reads pass, while hosted `room_read_work` with `includeResult` + `includeDiscussion` and REST selected discussion fail `409 current_room_context_required`. `RoomStore.workDiscussion` unconditionally hydrates `store.room()` and then scans all posting events. On the new source all three original controls pass.

The early current-only branch reads protected selected work, history floor, canonical messages and addressed ancestry. It reuses existing code-owned public/incoming/outgoing message indexes to admit at most five bounded metadata rows per visibility stream, merges them and examines at most four authorized sources. Hidden DMs outside the viewer's parties consume no source slot. Relation and history predicates follow source admission; source messages may predate the task, linked messages are selected, other-work branches are excluded, and unlinked replies follow their addressed ancestry. At most twelve unique message dependencies/eight parent levels can be read per call. Exceeding those or existing payload bounds fails explicitly. No index, schema, proof/writer/auth modification or whole-room fallback was added.

The operation shares a 512-record reservation with ordinary protected authority checks; existing 256 KiB aggregate input and 128 KiB per-record bounds remain. Each delivered posting event is scalar-admitted before the qualified metadata envelope is projected; only that envelope is read into JavaScript and its identity is compared to the proved current message. Historical raw posting text is never needed for the current discussion. Output rows remain capped at 64 KiB. This logical input bound is not a cap on repeated physical SQL transfer.

The normalized response deliberately uses contractVersion 2, with opaque server-owned encrypted continuation and truthful empty-more pages. SDK validation recognizes this version explicitly; version 1 remains unchanged. Tokens bind current protected head, selected work, viewer/credential/session and scalar addressed floor basis. A room write, authority change or service restart yields `discussion_reset_required`, with instructions to discard retained text and restart without a token. This is conservative current-head consistency, not a retained temporal snapshot or efficient hot-room protocol. Completed consistent tokens also cannot bridge a changed head. Numeric since is an unanchored filter and must be discarded after recovery.

The existing preparation loop follows empty-more pages, makes at most four calls, and returns a concrete continuation when still incomplete. The current result composition rechecks work/session/receipt identity; an interleaved change or withdrawn result never becomes a mixed successful review. Installed v1-only clients fail closed on v2. Authoritative API/WORK-CONTEXT documentation records the changed contract.

## Qualification

- Original extracted reproduction: before 1 pass / 2 fail; after 3 pass.
- Current Node tests: 8 pass, covering actual hosted/REST SDK, actual adopted OAuth, exact result composition, private subtree and other-work exclusion, source anchor, empty-more/nonduplicate paging, since-join protected floor, oversized refusal, malformed v2, head/viewer/work mismatch, cold restart, revocation, incomplete preparation, interleaved change/withdrawal and failed-read same-cursor retry. Whole-room hydration throws.
- Current plus legacy discussion/preparation/review neighborhood: 40 pass on a805 + follow-up tests. Final 8853 adds an own-work check (reserved unknown identity remains a refusal) and calls the reader directly for the already-covered since-join case; the focused 8 and Native check then pass again.
- Actual production Native SQLite HTTP: 1 pass at 1,000/5,000 synthetic history rows. It checks first/three advancing empty pages and an explicit since-tail selection, hidden-only history completeness, and cold fresh reopen. It does not enumerate all unrelated visible history.
- Existing runtime import closure/preflight: 2 pass; project preflight 739 runtime sources; workItems census/candidate manifest: 15 pass. New Native check is explicitly registered in `cloudflare/package.json`; new server module is in the optional runtime allowlist. Census classifies the module as a reader, preserving all existing mapping/divergence assertions. Lint and secret scan have no errors; no exemption was added.

## Measured Native per-page cost

| Source history | Rows | SQL statements | Physical reads | SQL returned string bytes | SQL text bytes | Binding bytes | Adapter/raw writes |
|---|---:|---:|---:|---:|---:|---:|---:|
| Unrelated public | 1,000 | 168 | 938 | 269,150 | 21,981 | 5,171 | 0 / 0 |
| Unrelated public | 5,000 | 168 | 938 | 238,314 | 21,981 | 5,171 | 0 / 0 |
| Private to other parties | 1,000 | 162 | 925 | 281,920 | 19,477 | 5,100 | 0 / 0 |
| Private to other parties | 5,000 | 162 | 925 | 252,453 | 19,477 | 5,100 | 0 / 0 |

All measured cursor counters are known. Final Worker wall observations are 4–12 ms locally, not production latency or CPU measurements. Rows/calls are flat for these selected pages; returned bytes are explicitly not identical. No claim of total enumeration efficiency: many unrelated authorized messages still require repeated four-source pages, and a hot room may repeatedly invalidate them. Efficient indexed task selection and tolerant historical continuation remain unfinished work, outside this no-schema slice.

Commands (Node24 `/Users/johnpotter/.local/bin/node`):

```
node --test tests/current-work-discussion.test.mjs tests/work-discussion.test.js tests/work-preparation.test.js tests/work-review-preparation.test.js
node --test cloudflare/current-work-discussion-native.check.mjs
node --test --test-name-pattern='every module in the server import closure|runtime preflight checks the working source' tests/runtime-package.test.js
node --test tests/workitems-board-step0-census.test.js tests/candidate-manifest.test.js
```

Raw compressed synthetic logs, hashes, counts and Native metrics are in `audit/evidence/current-work-discussion-20261103/receipt.json`. No production data, credentials, writes, migration, push or deployment were used. Recovery protocols and the remaining full oracle are unchanged.

## Historical-opening correction on current main

The unpublished branch was rebased onto `ab64102f1354064bbeb28fa86e50a249393796d5`, preserving the qualified #5780 event envelope reader and #5781 package/manifest inputs. The rebased source commits are 9278fb3da / c7d3a92c3 / 1e73ec315 / 6622549b3; the earlier evidence above retains its original source identities.

Independent review found an actual error in the first version: a legal 65,536-character CJK posting followed by 26 edits has a small proved current body, but its 196,868-byte obsolete opening event exceeded the consumer's raw 128 KiB JavaScript read bound. The exact independent reproduction passed the current-message control and failed discussion with 409 before this correction; it passes afterward.

The reader now calls the already-qualified `readCurrentEventEnvelope` with scalar sequence/idBytes/bodyBytes and the shared budget. SQL projects obsolete posted body to null before returning one bounded metadata row. The existing 128 KiB envelope/256 KiB protected input limits are unchanged. The consumer separately enforces the same 64 KiB raw-SQL source-prefix rule as the current event reader, allowing one legal first large atom, then stopping before the next unexamined opening with a continuation. The helper's existing finite raw-message SQL limit is reused; no cap, guard, proof or writer was widened. The canonical current-message reader still verifies the actual output body.

A new synthetic regression uses maximum CJK and escaped-control openings, each followed by 26 valid edits, plus a private large opening and a small public tail. It proves current CJK → current control → public tail across separate pages, exact cursor retry, no private text, and that obsolete raw text never enters any returned SQL cell in JavaScript. This one test fails on rebased pre-cure source and passes after. Original friend regressions remain 3/3; current+legacy/preparation/review is now 41/41. The actual Native HTTP check passes again including the historical sequence and cold fresh reread.

Current Native per-page costs after envelope integration: public 168 statements / 960 physical reads at both 1k and 5k; private-only 162 / 970 at both sizes. Returned SQL strings are 269,141 / 238,305 bytes (public), 281,893 / 252,426 (private); SQL text 23,516 / 22,547 and bindings 5,180 / 5,118 respectively. All writes and unknown counters remain zero. Historical CJK first page: 151 statements / 939 reads / 179,467 returned SQL string bytes / 20,154 SQL text bytes / 4,103 binding bytes, zero writes/unknown. This adds SQL envelope work (+22/+45 physical reads versus the earlier simple-opening fixture), not a general speedup claim. Raw historical-body handling is now legal and bounded. Local Worker wall observations of 3–5 ms do not establish production latency or CPU.

New raw logs are recorded separately under the envelope-cure evidence receipt; earlier measurements are not relabeled as this source. All prior head-bound continuation and unrelated-history limitations still apply.
