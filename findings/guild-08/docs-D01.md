# Guild-08 suite docs — D01

What each suite actually proves (not what its filename claims). 13 files.

## account-deletion-rooms.test.js (4 tests)
Proves the account-deletion HTTP contract: a solely-owned personal room is archived and its messages/files purged; a shared room with another owner transfers ownership and the account is deleted; a sole owner of a shared room with other members is refused and gets the room list; the confirmation token covers room contents (a later message invalidates the plan). Does NOT prove the purge is irreversible or that backups are cleaned.

## account-rooms.test.js (4 tests)
Proves account room discovery is bounded/paginated, returns only currently-authorized memberships without room content, works over HTTP with CSRF, keeps archived rooms listed read-only, and answers while another writer holds the DB and on a read-only store. No header comment; the tests are integration-level.

## agent-rooms-idempotent-budget.test.js (5 tests)
Proves the room-creation budget is idempotent: identical retries don't spend budget, real creations do, replays are free even when exhausted, claiming someone else's room id is refused for free, unknown secrets are rejected before budget is considered. This is budget accounting, not room semantics.

## agent-rooms.test.js (31 tests)
The big self-serve room-creation suite. Proves: identity creates room and becomes owner; same-params retry returns duplicate:true; id collision with different params is 409; another identity can't claim the id; per-identity budget enforced; bad secrets are 401; owner transfer to agent member is auditable; non-owner transfer is 403; transfer to unknown/inactive member is 404; agent owner may set policy/spend allowance and archive its own room. Ownership + transfer + budget contract.

## analytics-claim-bond-shadow.test.js (17 tests)
Proves the claim-bond SHADOW journal (not real bonds) faithfully mirrors the spec lifecycle: lock at claim, release on done/clean release, forfeit + flake on expiry/judged-bad, carry on reassign, nothing on renew/note-review/unrelated actions, idempotent re-runs, no phantom entries. Shadow-only — proves the observer, not any real economic effect.

## claim-autolink-http.test.js (1 test)
Proves exactly one thing: the real PR webhook receiver is mounted, disabled by default, and rejects unauthenticated deliveries. Thin but honest.

## claim-autolink.test.js (18 tests)
Proves PR↔claim auto-linking: claim-id parsing priority (marker > branch > title > body), exact branch-segment matching, ambiguity never guesses, done/unclaimed items aren't link targets, duplicate/settled links refused, webhook opened-links vs closed+merged-settles, unlinked-PR discovery. Pure linking logic.

## claim-bond-shadow-attacks.test.js (3 tests)
Proves the shadow journal's safety invariants: syncShadowJournal writes ONLY its own journal table (write confinement), every row is marked hypothetical, shadowReport performs no writes. Adversarial framing — proves the shadow can't silently move real value.

## claim-collisions.test.js (7 tests)
Proves the file-collision detector: two open claims sharing a file are flagged with all shared files sorted and lanes deduplicated; closed claims never collide; no self-collision on duplicate entries; path normalization (./ and // variants); empty/disjoint inputs are clean; malformed inputs throw coded errors. Pure function, well pinned.

## claim-map.test.js (8 tests)
Proves the live file/region claim registry via the real scripts/room: rebuild renders ## file-claims (file → lane → task → state, live only) and ## overlap-warnings ((none) when clean); the signals line carries files_claimed/overlap_files; the overlaps verb reports live holders per file and ignores closed claims. Board-render + CLI-verb contract.

## claim-overlaps.test.js (3 tests)
Proves the warn-don't-block overlap contract: an overlapping claim still succeeds but records the other work item, holder, and shared paths; other repos/released/expired claims don't overlap; overlaps are deterministic on replay. Only 3 tests but each pins a distinct behavior.

## claim-pr-sync-room-scoping.test.js (1 test)
Proves one critical scoping invariant: the PR-settlement cron resolves the same claimId in two rooms against each room's own claim (roomId, claimId) scoping — a bare-claimId roomOf map would settle the wrong room. Single-test, high-value regression.

## claim-reputation.test.js (35 tests)
Proves the P1 reputation projector implements the spec: signal types (+3 done, +1 release, -6 flake, judged-bad), HOARDING_CAP frozen at 5, surcharge at/above cap, flakes attributed to previous owner, expiry on unobserved claims still emits, null-lease claims count toward cap. Spec-conformance suite.
