# Ask, clarify, deliver: implementation plan

September 8, 2026. Starting from clean135d824/runtime975f5e5. User authorized
research, planning, implementation and the proposed local browser/actual-agent
acceptance exercise. Publication, other-product changes, external account setup,
paid execution services and recurring automation are outside this milestone.

## Research decisions

- Preserve frozen input/history and explicit current state. Linear warns that
  mutable comments alone are insufficient for reconstructing agent interaction.
  Our immutable messages and anchored request reads already supply the foundation.
  [Linear](https://linear.app/developers/agent-best-practices).
- Keep original operation identity over pauses/retries; resuming an execution
  can replay steps, so side effects need deliberate idempotency. Do not refresh
  request basis implicitly while retrying an unknown outcome.
  [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/interrupts).
- Announce status changes without stealing focus. Keep one local status region
  responsible for composer errors; make extra modes contextual and keyboard usable.
  [W3C](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).
- Use a per-invocation native Codex MCP configuration and selected tools for the
  synthetic acceptance fixture; do not modify the user's saved host configuration.
  Installed hosts discovered: Codex CLI0.153.4 and Claude Code2.1.259. Availability
  is not acceptance; record actual connection success or the specific failure.
  [Official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

## Product contract and visual thesis

Keep the existing quiet conversation. An optional Request a reply control opens
the mode in the current composer. Requests show their state inline. Exact recipients
can Answer or Decline; ordinary Reply clarifies without ending a request. The
requester/actual owner can cancel with a reason. All text remains room-visible.
Use one compact mode bar and the existing send button/Enter behavior, not a new
navigation destination. Do not translate request completion into work acceptance,
independent review, human approval, payment or runtime termination.

## Implementation order

Progress note: the user redirected immediate attention to a quieter login and a
whole-interface copy/layout review. See QUIET-INTERFACE-REVIEW-2026-09-08.md.
The initial read-only native probe has now been extended: Codex CLI completed
clarification, fresh-process reconnect, original result submission and request
answer. Claude Code connected and inspected the result, but did not verify it:
the test omitted a required scoped discussion reader. The corrected rerun was
blocked over potential model-usage charges and awaits current user approval.
Codex shutdown-path warnings remain. See NATIVE-HOST-REQUEST-CHECKPOINT-2026-09-08.md;
this is partial native acceptance, not a completed author/reviewer exercise.
The contextual request composer, scoped recovery, and human contribution/return/
review journey are now implemented and locally browser-qualified. See
CONTRIBUTION-JOURNEY-2026-09-08.md. Observer v3 is now implemented as an explicit
new-directory choice, with local CLI/MCP and persistence tests; see
CURRENT-ATTENTION.md. The complete actual native-host author/reviewer request loop
and current hosted qualification are still to do. Local protocol scripts are not
native-host acceptance or deployment evidence.

1. **Early native-host check.** Run a disposable loopback fixture and a narrowly
   configured native host read. No existing private history, configuration edits,
   unrelated tools or secret logging. Retain host version and actual tool event.
2. **Owned composer state.** Introduce explicit request modes with separate draft
   keys per request/outcome; ordinary thread drafts retain their existing keys.
   Switching requestA to requestB in one thread saves/restores rather than retargets.
   Keep subject, context basis, revision and pending command together. A mode switch
   must never copy an unknown operation into a different request.
3. **Human actions.** Read the entire bounded selected request before offering an
   answer basis. Check session generation across asynchronous reads. Expose refresh
   after a definitive stale-context refusal, preserve text, and require an explicit
   user retry after refresh. Unknown outcomes retain the immutable original command.
   Cancellation uses the same reason/draft/receipt discipline, with no fake message.
4. **Tab recovery.** Extend recovery with a validated versioned request branch.
   Preserve ordinary legacy recovery. Reconstruct only allowed command fields from
   validated draft data and exact content; reject injected commands, stale identities
   and wrong request/recipient links. Existing session binding and expiry remain.
5. **Request attention.** Explicit operator choice of observerv3 and a new directory;
   defaultv2 unchanged, no silent migration. Add current incoming requests, answered/
   declined outgoing requests and unavailable-recipient conditions. Metadata and read
   pointers only. Exact context changes replace a notice; old acknowledgements cannot
   clear a replacement. Require service support detection before reconciling requests.
   Keep canonical history distinct from the local current-condition inbox.
6. **Qualification.** Focused pure/client/UI tests, full regression suites, package
   verification and actual agent work with independent review. New request UI gets
   desktop/touch/large-text screenshots. Native-host tests remain labeled separately
   from protocol subprocess tests and from coordinator-hosted agents.

## File boundaries

- Browser: existing app/conversation integration plus one focused request-composer
  helper if it reduces duplicate validation. Existing styles and semantic controls.
- Service: existing request domain/read implementation remains canonical. Add an
  explicit read-only request-support marker where needed; no new task database.
- Observer: existing journal/reconciliation with explicitv3 compatibility checks;
  CLI/MCP configuration routes select the same version. Version-specific capacity
  must allow500 work+500 request+1 instruction conditions.
- Tests: dedicated request-composer and attention-v3 fixtures; preserve independent
  runtime validation rather than merging all assertions into one shared implementation.

## Required scenarios

Success: human requests a useful result; agent reads it, asks a question; human
answers; agent reconnects, reads current context and contributes original output;
reviewer checks exact bytes; human decision remains pending.

Failure/recovery: newer clarification during composition; unrelated chatter remains
irrelevant; inactive original requester; expired/revoked access; same-thread request
switch; pending response survives supported reload; cancellation unknown outcome;
request terminal between polls; old observer directory refusal; no-body attention;
wrong/unsupported service cannot clear notices; keyboard/IME/touch/focus preserved.

Tests must distinguish AUTO scripted transitions, SIM browser-operated human roles,
AGENT original model-authored work and HOST native client acceptance. None proves
human enjoyment/retention, isolated provider execution or production readiness.

## Checkpoint and release boundary

Record exact tested source/package, evidence paths, passed and unrun gates, process
cleanup and remaining limitations. Preserve existing previews and discard only our
own validated disposable fixture credentials/data. Do not mark the whole goal
complete after this milestone. Schema-compatible fallback and hosted recovery
remain separate release gates; publication requires explicit approval.
