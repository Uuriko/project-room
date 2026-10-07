# Project Room QA watch ledger - 2026-10-07

Scope: QA-only, no production changes. Current evidence is from repository `Uuriko/project-room` at `8a4b3a6af4fbd9e633e6b27b17c7b342fefec5b7`. This is a per-slice ledger, not a claim that the full eight-point plan is complete. Keep observations separate from implementation or deployment status.

## Ownership boundaries

- This lane's execution boundary is points 1, 2, 5, 6 and 8, routed by the parent after checking room ownership. The chosen sequence test is limited to persistent SQLite storage refusal/recovery and does not cover the retry/recovery browser pass.
- Point 5's share-link join-retry slice was reported by the Room lane as exercised by Fo in `tests/share-link-join-concurrency.test.js`; this lane did not repeat it. Treat that as coordination data, not owner authorization. Additional mutation-adequacy work outside that slice remains untested.
- The parent relayed that John's Tab offered a patch testing the reducer's duplicate-message guard; this lane has not independently inspected that branch/patch and will not duplicate it. Any point-5 work must avoid both that reducer case and Fo's join-retry slice.
- The parent directed this lane to stay off points 3, 4 and 7 based on the room ownership scan; this ledger does not claim them.
- Points 1 and 2 overlap the overall plan's invariants and sequence-testing themes. This lane's current specific test is only the refusal -> exact retry -> persistent reopen path below.

## Tested cases

| Plan point | Case | Source / command | Result |
| --- | --- | --- | --- |
| 1, 2, 6 | Committed message bytes survive an actual SQLite `SQLITE_FULL` refusal; refused command changes no committed event/command/sequence/projection; the exact command retries once after capacity recovery; exact retry is a duplicate on repeat; event and command journals and message bytes survive close/reopen | `tests/storage-recovery-sequence.test.js`; `scripts/test-env.sh node --test tests/storage-recovery-sequence.test.js` | Pass, 1/1 |
| 1, 2 | Existing storage refusal, rollback, health recovery and duplicate-replay checks | `tests/storage-failure.test.js`; `scripts/test-env.sh node --test tests/storage-failure.test.js tests/storage-recovery-sequence.test.js` | Pass, combined 6/6 |
| 1, 2 | Existing hosted/local `room_read_messages` sparse paging and parity coverage | `tests/mcp-room-messages-paging.test.js`; final combined command below | Pass, 7/7 |

Environment note: the installed local Node reported `v22.23.3`; Project Room declares Node `>=24.19.0`. These local focused results are real but not canonical-runtime validation. Hosted CI on the final head is still needed.

## Observed difference with unresolved contract

- Independently checked locally at the recorded base with an in-memory room: post/edit a message and post/delete another, then call hosted `room_read_messages`. The edited row carries the current edited body but no `editedAt` or revision; the deleted row has `body: ""` and no explicit deleted marker. The same projection carries the edited timestamp and deletion timestamp. This confirms the observed serialization difference, not that the tool violates its contract.
- Disposition: contract unknown. Referred to the parent/result-comparison owner for a contract decision; no assertion was added. Parent relayed that John's Tab has offered a two-commit change for deleted/edited markers plus the duplicate-message guard test, routed to other lanes. That is external coordination context, not independently validated patch state. Do not duplicate it here.

## Failed, unknown, and follow-up

- Failed: none in the final focused runs. An initial assertion compared a SQLite row object with a plain object; corrected to compare the row's sequence value, then reran successfully. This was a test-harness assertion shape issue, not a product finding.
- Unknown: broader `npm test`, the canonical Node 24 run, browser tests, and hosted CI on any PR head have not been run in this lane.
- Unknown: no product defect has been confirmed by the storage sequence slice; there is no separate storage bug/fix claim. The new test is preventive sequence coverage.
- Unknown: whether hosted `room_read_messages` is required to expose edit/delete state metadata; the parity difference above is not a finding unless the owning contract decision confirms that requirement.
- Unknown: points 1, 2, 5, 6, 8 are not complete beyond the exact rows above. No general ledger automation or broad mutation score was measured.

## Next step

Final focused run: `scripts/test-env.sh node --test tests/storage-failure.test.js tests/storage-recovery-sequence.test.js tests/mcp-room-messages-paging.test.js` passed 13/13 on local Node v22.23.3. Check the new regression under the repository's supported Node 24 CI runtime and keep this ledger current with exact tested/failed/unknown results. Add a defect-specific minimal repro only after a confirmed defect has a repeatable failure; do not report this sequence test as a repair for an observed bug.
