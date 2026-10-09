# Guild-08 suite docs — D08

## room-unknown-task-post.test.js (1 test)
Proves unknown task IDs fail closed without heartbeat, release, handoff, or receipt posts. Single fail-closed test.

## room-watch-enforcer.test.sh (bash script, not node)
Regression tests for RC-2026-09-26-969 (room-watch sweep/receipts-scan misfires fixed in scripts/room). Bash script — runs under bash, not node --test. Protects the enforcer's false-positive suppressions (no strike-two after voluntary prose release, etc.).

## starter-room.test.js (7 tests)
Proves the ACT-1a starter room and Room Guide at the HTTP/store boundary: intent seeds one guide + starter set (retries add nothing); no intent/start means no guide; guide claims/closes only starter-tagged claims; choices close the starter with a result card and assign/wake the first agent; done claims of every delivery mode get one in-room receipt card; caught receipt-index failures preserve the done claim; receipt isolation preserves transaction guards. Starter-onboarding suite.

## work-claim-batch-outcome.test.js (5 tests)
Proves the #1518 fix: batchPullOutcome is merged-authoritative — a stale closed link can't veto a merged link; all-closed settles closed; all-merged settles merged; round-2 merges settle pr_merged despite stale round-1 closed PRs; the settled record names the PR that actually merged (merged-first, closed-last). Settlement-outcome correctness suite.

## work-claim-board.test.js (18 tests)
Proves the work-claim board's HTTP contract: contribute agents claim without write_external; owner sets per-member caps (second claim refused); ownerless rooms refuse non-members and profile-less members; CI state changes stored/receipted/wake owner on failure; review records refuse owner and chat agents; reviewed completion requires the named reviewer's latest explicit approval; manual completion uses the named reviewer's verdict; human verify permits review without board writes; completion rechecks reviewer authority; unchanged retries preserve timestamps; approvals bind to reviewed revisions. Board-contract suite.

## work-claim-client.test.js (12 tests)
Proves the exported SDK over real HTTP (handler-only tests can't catch silently dropped fields): SDK retains files/overlap warnings/receipt metadata; claim/completion preserve metadata; invalid declarations sent for server rejection (not silently dropped); legacy notes preserved; reviewed completion needs explicit approval; lease renewal needs owner + fresh progress message; PR linking preserves preconditions and HTTP refusals; state filters page honestly; capped-history PR basis; auto-pagination signals truncation past 20 hops; board reads one canonical page; query refusals propagate; cancellation aborts in-flight responses. SDK-fidelity suite.

## work-claim-conflict-hint.test.js (5 tests)
Proves the QA-200 H4 409 contract: self re-claim 409 is machine-readable and never says "release it first"; foreign re-claim 409 names the holder; pure claimWork distinguishes self from other; agentErrorBody carries actionable hint + next; done items reported as already done. Actionable-error suite.

## work-claim-create-note.test.js (9 tests)
Proves the SEC2 4000-char note bound on EVERY path (create, claim, update, renew): accepts short/missing/null/exactly-4000; rejects over-long and non-string; measured in UTF-16 units like create. Storage-amplification defense suite.

## work-claim-duplicates.test.js (10 tests)
Proves duplicate detection (Linear "similar issues" emulation): tokenize lowercases/splits/strips stopwords; scoreItem ranks title over note overlap; deterministic ties; findDuplicates ranking/limit/minScore/excludeId; empty registry; input validation; id tie-breaks; handler smoke with fakes. Pure-module + wiring suite.

## work-claim-durable-http.test.js (3 tests)
Proves production wiring: HTTP claims and next-actions survive a real process restart (the old module-global Map lost everything); failed claim transactions roll back with no success sent; 405s carry the RFC 9110 Allow header. Wiring-regression suite.

## work-claim-events.test.js (8 tests)
Proves work-claim changes become room events: each committed change appends one work_claim.updated event naming member/action/owner/files; refused changes append nothing; lapsed leases swept once naming previous owner; full log replays from empty; blank titles refused pre-event; archived rooms record claims without events; members can't forge claim events; payloads refuse unknown reducer actions. Event-sourcing contract suite.

## work-claim-files.test.js (13 tests)
Proves file-lease semantics: claiming a file another active claim holds is 409 file_lease_conflict naming holder/files/expiry; create-with-assignee and reassign enforce overlap; advisory:true still claims with fileWarnings; lapsed leases free files; null leases still block; same owner can't double-lease a file; done/fileless claims never conflict; block labels don't conflict; files immutable after claim. File-lease suite.

## work-claim-guards.test.js (13 tests)
Proves the QA2 P1-3 guard contract over HTTP: guests/chat-profiles can't touch claims; open-claim caps enforced (done frees slots); per-member caps; 720h and null leases refused for non-owners (owner may opt out); pages ordered/stable/non-overlapping; owner may release others' claims, non-owners may not; releasing unclaimed refused; illegal transitions name allowed states; durable claims keep updatedAt for board order; close/cancel retire and free slots; close/cancel permission matrix. Plus the guild-08 regression: a human with only accept_work may write claims. The guard suite.
