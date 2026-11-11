# Native bonds and private peer DMs

Source `3b6094f49c628f16dad5f81acedc1b2617c73ccc` on `a2a4e31b4`, runtime/tests commit 3b6094f49. Local tested source, not deployed/live proof. No account replacement, new grants, new data domain, DDL, format bump or cap increase.

The existing normalized command path refused bond propose/accept/decline/revoke and peer dm.posted. The existing suites went from **12 tests: 1 pass / 11 fail** to green. The qualified context loads only the protected prior bond; a live proposal chooses its ID in Bonds.prepare, so a request-local deferred loader binds that exact record before reducer application and before calculating the metadata diff. Accept/revoke retain note, original scopes and timestamps. Old revoked receipts remain after a fresh consent proposal. Legacy reducer and authorization service are unchanged.

Store bond.list and Bonds owner checks now use selected protected authority. A separate causal diagnostic identified eager HTTP peerContext roomAuthority(roomId) reading the entire roster before route dispatch; selecting the authenticated viewer fixes legitimate incoming-cap checks without widening the input cap. Original scope attenuation, proposal TTL/caps, cross-room owner revoke refusal, revoked-identity refusal, peer-only DM history and directed wakes remain covered.

Native inbox now composes bounded indexed side-table windows: at most 32 proposed rows per identity-party prefix and 32 newest incoming peer-message candidates. Residual TTL, proposer and room filters run after source admission. Scalar byte bounds precede addressed payload fetch; foreign-room bodies are not fetched, and at most the requested response count is hydrated. Existing peer-room/identity rules apply. Incomplete sources expose explicit coverage and existing bond-list/thread inspection pointers; they do not assert attention is complete. No new scan/index or blanket all-history hydration. Existing legacy complete inspection APIs are unchanged. The current formal-reply exclusion from ca091 is preserved, and formal selected-request pointers now retain roomId (coordinated with their owner).

Final exact frozen command:

`/Users/johnpotter/.local/bin/node --test tests/current-bonds.test.mjs tests/bonds.test.js tests/bonds-m3.test.js cloudflare/current-bonds.check.mjs`

**16/16 pass, zero skip, exit 0** (15 Node, one actual default July Native SQLite). Native uses actual AgentRooms creation and identity holder proof, consent/attenuation, independent protected prior fields, injected peer-side-table write failure with atomic rollback, useful saved message/inbox, dispose/cold restart/exact retry, private bystander refusal, revoke refusal, closed writer and default literal auditRecovery. It is a synthetic local Worker, not Cloudflare production CPU/memory or a hosted deployment claim.

New Node controls also compare the independent audit oracle, retry after reopening SQLite, rollback proposal/DM event/thread/message state together, assert prior receipt immutability, inspect existing-index EXPLAIN plans (no temporary sort), and measure three addressed message body fetches for a three-result page out of 40 valid sends. The 40-send fixture advances a controlled clock rather than disabling the real flood limiter. Its earlier burst-refusal test log is retained honestly. Oversized selected source body refuses before materialization.

Neighbor native-inbox/events tests: **19 total, 17 pass / 2 fail**. Both failures occur in existing readCurrentInboxDiscovery before this new peer presentation. Running the same two test patterns against the exact a2a runtime in the unchanged attachment test worktree reproduces both. These are retained as inherited context-budget failures, not waived or counted green. No full suite claim.

ESLint: exit 0, zero errors and 34 inherited warnings in shared large files. git diff --check: exit 0. Secret scan against a2a source: clean, exit 0. The diagnostic temporary logger was removed before freezing. Complete gzip log hashes, source hashes and actual exit codes are in receipt.json. No runtime source changed after this receipt source pin.
