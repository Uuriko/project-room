# Agent interface: evidence from the Commons release-review trial

John's November 16 direction: design for agents using direct commands, not menu navigation. Optimize accepted quality and continuity first, then round trips, bytes/tokens and latency. This is a bounded design/experiment record, not a replacement task ledger or a release approval.

## Actual contribution and independent review

Codex completed `privacy-release-e220-evidence-20261116` in Commons. The native result is completion `c5682804-b7cc-4f85-b00d-2a8406be463c`, hash `sha256:51bd88bb455e19994ca022937c50c9ab9f58454fea8d8c6ec671789f54aafe84`. Public packet: https://github.com/Uuriko/project-room/pull/6253#issuecomment-6939224971.

Actual Jill-Dot independently reviewed it and replied at sequence 100. She verified the exact hosted run and accepted the packet's bounded claims, adding that 1474 affected and 106 entry/privacy test counts overlap and must not be summed as unique tests; lint had zero errors and 387 warnings. No tests were needlessly repeated. Her selected-work read exposed the exact result and her verifier role together. This is real cross-runtime collaboration, but formal verification is still pending, not recorded under Codex's identity. One manual host wake was used; Room did not automatically wake her.

Observed friction:

- Task proposal returned `unconfirmed` twice despite one persisted proposal at sequence 91. Current source and packaged bc7539ff receipt validators both accept the stored receipt in an isolated replay. Root cause in the active connector remains unresolved; do not label it fixed or invent a server failure.
- A first-call Begin invocation ID was wrongly supplied by Codex. The tool treated it as a recovery ID and refused invocation_mismatch. Omitting it worked. The interface should distinguish an initial idempotency key from a resume token; this was caller misuse, not evidence of a failed write.
- An unsigned external evidence URL was refused. Native draft -> exact preview -> submit succeeded. Offer the native route first rather than requiring an agent to learn it through rejection.
- Room grants and OAuth consent differ. More importantly, `room_record_verification` was absent from the OAuth allowlist even with work:write. This branch adds that existing tool, retaining permission/role/exact-version gates. Both storage regressions failed discovery before the patch. Legacy now verifies; normalized reaches an existing bounded-context error (202 records against 200), still under investigation. Do not deploy this draft.
- Room's next action is useful but must also report whether the actual transport can perform it; otherwise the agent gets a correct task assignment it cannot execute.

## Primary-source research and implications

- Anthropic, Writing effective tools for agents: task-oriented tools, measured agent evaluations, selective context, concise/detail choices. Apply to existing Room operations rather than expose every reducer as a default tool. https://www.anthropic.com/research/writing-tools-for-agents
- Anthropic, Code execution with MCP: discover tools progressively and process intermediate results in code. Use a typed SDK/CLI for loops, joins and bounded batch reads; send only decision-relevant results to the model. https://www.anthropic.com/research/code-execution-with-mcp
- Linear agent interactions: agent sessions and activities with targeted webhooks; structured context and distinct working/input/error states. Adopt explicit delivery/run distinctions; webhook acceptance is not work completion. https://linear.app/developers/agent-interaction
- Beads: ready/show/atomic claim commands and JSON output offer a short contribution loop. Its documented HTTP divergences are also useful: advertise limitations instead of silently approximating semantics. Reuse patterns; do not import a second task store. Repository is MIT licensed; no code copied in this slice. https://github.com/gastownhall/beads
- MCP tools specification: typed inputs/outputs and structuredContent support a machine-readable contract. Retain required compatibility text, but avoid redundant prose inside the canonical payload. https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx

No source establishes one universally fastest serialization or transport. Compare our actual hosts and work, not marketing benchmarks.

## Target interface, using existing authority and storage

These are proposed ergonomic contracts, not currently shipped command names:

| Agent intent | Return/action | Existing foundation |
| --- | --- | --- |
| Resume / choose next | Goal, source revision, obligations, eligible next work, blockers, completeness/cursor, effective tool capabilities | resume, needs_me, project state |
| Prepare selected task | Scope, acceptance checks, exact current/prior evidence, dependencies, executable next-action arguments | read_work + includeResult |
| Begin selected work | Checked accept/claim/start, one stable operation identity and resumable stage receipts | begin_work |
| Submit result | Persist exact body, bind hash/event, record completion, return review destination; safely resume partial progress | post draft + read result + submit text result |
| Review result | Explicit verdict on exact completion/hash; return newly ready next action | record_verification |
| Wait for relevant change | Cursor-bound targeted notification through supported host adapter, explicit delivery/execution state | existing attention/subscription primitives |

MCP is the default for connected agents; CLI JSON and typed SDK should expose the same semantics for terminal/code-capable agents. Do not make the agent enumerate UI menus, infer button labels, copy hashes by hand, scrape whole boards, or load every historical message. Keep explicit IDs in executable arguments even in concise results. Human UI is for oversight and exceptional consent, not the normal work path.

Default response fields should distinguish `roomPermission`, `oauthConsent`, `toolAvailable`, `hostExecution`, and a concrete recovery action. A permission claim alone must not yield `canExecute:true`.

## Priorities and evaluation

1. Finish OAuth verifier parity and its normalized regression; retain readonly/stale-version/role controls.
2. Diagnose false-unconfirmed proposal receipts at the actual connector boundary using sanitized command/receipt metadata.
3. Compact effective-capability + next-action packet, reusing current context. Prove it distinguishes consent absence from catalog absence.
4. Compose native result submission behind one resumable SDK/MCP operation; preserve separate immutable result and completion events, never collapse review into completion.
5. Measure native event-driven host pickup only where supported; no new universal wake/fleet subsystem.

Run comparable new, returning, producer and reviewer journeys before/after: accepted correct results, missing evidence, corrections/reopened work, wrong-version acceptance, human interventions, model turns, tool calls, payload bytes and elapsed time. Count retries and failed attempts. Latency/tokens may improve only if privacy, exact-version review and recovery correctness remain intact. Targets: zero routine UI clicks after supported authorization; no manual John message relay; one selected read for review preparation. These are targets, not achieved performance claims.
