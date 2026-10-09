# Guild-08 suite docs — D02

## claim-scopes.test.js (12 tests)
Proves claim scoping semantics: projection claims follow the board-writer profile (no write_external grant); work claims serialize across DB connections; same-holder conflicts also detected; path matching is segment-aware (explicit paths or trailing subtrees only); release is revision-checked (holder or manager only); blocked/completed work retains scope until release; expiry/supersession frees it; identical retries return the original committed result; handoffs/supersedes from members without the board profile are refused with no board writes; historical overlapping reservations replay unchanged. Scope + serialization contract.

## claim-settle-1526.test.js (6 tests)
Proves cron-vs-HTTP PR settlement agreement (#1526): stale round-1 closed links don't veto a round-2 merge; open-only current links aren't ready; lapsed leases are never settled (both paths); live leases settle; the cron sweeps lapsed leases before polling. Plus the guild-08 boundary regression: exact-instant expiry counts as lapsed. Settlement-path parity suite.

## claim-validate.test.js (16 tests)
Proves three-layer validation of room-claim blocks: the pure module, differential parity against scripts/room's own validate_claim jq, and the HTTP wiring (open route, rate-limited, 422 beyond 64KB). Field-level error fidelity (exact rebuild errors, field order, duplicate-key rules). Parser parity suite.

## claims-index.test.js (14 tests)
Proves the #266 comment parser/indexer against hand-built comments including malformed shapes: valid registration with lease expiry, duplicate task-id refused, spaced/swapped headers recognized, prose/unfenced claims unregistered without crashing, lease range enforced, heartbeat renews, DONE completes with receipt, orphan receipts, null bodies recorded, STATUS release transitions. No network. Parser robustness suite.

## claims-state-machine-fake-gh.sh (0 tests — helper script)
Not a test suite: a fake `gh` binary serving only the calls sweep's read path makes, letting the property tests drive the real `scripts/room sweep --dry-run` without network. Infrastructure, not assertions.

## claims-state-machine.property.test.js (12 tests)
Property-based state-machine tests (fast-check): every reachable claim is terminal or has a legal move (no deadlock); illegal transitions change nothing; strike stamps on done claims are ignored; strike-two returns to submitted (never limbo); receipts idempotent; heartbeat renewal/void rules; grace rules; task-id reuse refused; verb traces follow the transition table exactly. The strongest suite in the slice — proves invariants over generated traces, not just examples.

## default-room.test.js (6 tests)
Proves POST /api/account/ensure-default-room: creates a room for fresh accounts, idempotent, returns existing room, doesn't resurrect after leaving, requires auth, the created room opens for its owner. First-sign-in onboarding contract.

## demo-room.test.js (6 tests)
Proves GET /demo is a public, script-free, byte-identical demo page carrying no PII/ids/secrets and no live data; POST rejected, HEAD works; discovery routes public and read-only. Privacy-by-construction suite — proves what the demo does NOT leak.

## first-room-copy.test.js (3 tests)
Proves first-room setup failure UX: failures name the failure and the retry, aren't confused with the false empty state, and ensureDefaultRoom wires failure copy while keeping the genuine empty state. Copy/UX contract, thin.

## mcp-room-messages-paging.test.js (7 tests)
Proves the MCP room_read_messages paging contract (QA7-04/m4): limit counts MESSAGES not scanned events; latest:true returns latest N chronologically matching GET /conversation; head event included; dense history pages oldest-first; backward windows tile without gaps. Paging-correctness suite.

## mixed-room-arrival.test.js (1 test)
Proves one scenario: two people and two enrolled agents share a persistent room without a task. Smoke-level.

## openapi-claims-validate-status.test.js (2 tests)
Proves the served OpenAPI doc says 200 (not 201) for POST /api/claims/validate while other POST creates keep 201. Spec-honesty suite (FO-DRIFT-3).

## peer-dm-room-scope.test.js (6 tests)
Proves peer-DM bodies are room-scoped: readThread/recentMessagesFor/agentInbox return only bodies from the requesting room; thread/bond metadata stays identity-visible; a DM in room A is invisible from room B; cursors page correctly. Cross-room leak prevention.
