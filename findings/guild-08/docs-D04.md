# Guild-08 suite docs — D04

## room-board-grammar.test.js (7 tests)
Proves the board's prose-receipt grammar: [lane][receipt] prefix recognized, receipts accumulate into state, DONE resolves task-id from the marker line (no truncation of RC-style ids), [lane][done] without a fenced block parses as done (no crash), unmarked CLAIM prose is logged without registering. Parser grammar suite.

## room-channels.test.js (12 tests)
Proves Phase-2 channels at reducer level and over HTTP: default main channel seeded; legacy rooms backfill on replay; channel create/rename/archive (owner-only); normalized unique names; messages route to addressed channels; unknown channels rejected; channelList ordering; command classification; replies pin to thread root; upgrade repair backfills #general. Channel lifecycle suite.

## room-charter.test.js (6 tests)
Proves the room charter's versioning and access: exact versions preserved; only active human owner updates; reads bind identity/selectors/version/horizon; legacy services report unavailable (distinct from unset); historical reads stay bounded; MCP orientation follows charter changes without adding authority. Charter governance suite.

## room-claim-status.test.js (5 tests)
Proves the `scripts/room claim-status` verb: prints one claim's live board state (lane, state, files, lease, expiry, heartbeat, strikes, claim id/time); reflects heartbeats; reports open strike-one; exits 1 on unknown/missing task-id. CLI pre-flight contract.

## room-cli-setup.test.js (8 tests)
Proves the CLI setup/doctor flow: Node 24.19 minimum; setup writes each tool config once (dry-run writes nothing, no secrets in configs); existing configs preserved except its own block; claude registration idempotent; token prints secret to stdout only; doctor exit codes; login stores private files; home alias accepted, escaping symlinks rejected. Installer hygiene suite.

## room-clock-skew.test.js (10 tests)
Proves clock-skew handling: operator clock 2h ahead/behind warns and uses board time (never strikes early, never silently delays); skew within 5min ignored; just over 5min corrects; --date parses HTTP dates, accepts bare values, fails loudly on garbage. Sweep never acts on a skewed clock. Time-safety suite.

## room-context-legacy-identity.test.js (1 test)
Proves compact context accepts legacy identities without turning a read into an auth-state write. Single regression.

## room-context.test.js (2 tests)
Proves the projection keeps refs but drops message/file/result bodies; get_room_context is not_modified when unchanged and never carries bodies. Read-purity for the context surface.

## room-coord-tail.test.js (4 tests)
Proves the room-coord tail/digest over real HTTP: tail returns only events concerning the caller; checkpoints never re-read; claim/land events read as lane changes; wake loop stops when the checkpoint stalls; bad checkpoints refused before reading. Wake-loop efficiency contract.

## room-coord.test.js (10 tests)
Proves room-first coordination verbs over real HTTP (verbs only count when the room's own work-claim record confirms them): directory claims cover subtrees; losers of races are released; renewal of missing claims fails before posting; done moves through in_progress; non-live leases never treated as claims; renewal posts public progress and extends; handoff moves the lease with an actionable post; status/digest cite each; the CLI refuses malformed input before any write. Coordination-verbs-truth suite.

## room-creation.test.js (4 tests)
Proves the stranger-first-room contract (RC-2026-09-19-080): zero-membership accounts may always create one room and become owner; further rooms require membership administration (guests/plain members denied); provisional room-key accounts denied even when the policy widens; HTTP 201 on first create, 200 on id replay, 403 for guests. Onboarding gate suite.

## room-credential-scan.test.js (3 tests)
Proves the credential scanner: minted-length room credentials are findings (including trailing hyphens); short prefixes aren't; the diff gate reports in-scope added lines. Secret-leak detection contract.

## room-deep-link.test.js (8 tests)
Proves deep-link parsing: roomIdFromHash, roomIdFromNext, hash-over-query preference, handoff href survival, auth gate naming, public door fragments, human invite/join share URLs. Link-integrity suite.
