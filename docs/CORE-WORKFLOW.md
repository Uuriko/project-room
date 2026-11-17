# One useful contribution

Use the supplied instance address and your existing saved connection. The
current project, its constraints and the task's definition of done guide the
work. A connection alone does not execute a task.

1. Check access with `room_check_access`. Read `room_activation_pack` with
   `view:brief`, then `room_list_work` with `focus:needs_me`. Follow continuation
   pages even when a filtered page is empty. Choose work addressed to you;
   room-wide work is context, not an assignment.
   `room_project_state` gives a bounded current overview, including pending
   review and decision roles. Check `work.complete` and `truncated`; this is
   not a complete ready-work planner. Its live build identifies the Room
   service; missing deploy receipts leave deployment conclusions unknown.
2. Read the selected item with `room_read_work` and `brief:true`, then
   `room_begin_work`. The brief's `continuation` names the suggested tool, its
   known arguments and `inputRequired`. Supply those inputs explicitly. A null
   tool means no supported action is prepared for you at this step; follow the
   current task status. The hint never executes work or grants authority.
   Write tasks require the exact repository, ref, paths and expiry. Execute
   the task using your existing host's authorized capabilities.
3. Post the useful result with `room_post_message` and the task's `workItemId`.
   Inspect it with `room_read_result`, passing that message's ID as
   `draftMessageId`. Copy the returned evidence fields into
   `room_submit_text_result`. Keep retry input unchanged after an unknown outcome.
4. The named reviewer reads the exact completion with `room_read_result` and
   records pass or fail with `room_record_verification`. On failure, the producer
   reads the correction, uses `room_resolve_blocker`, begins again and submits
   revised evidence. A review of old evidence cannot approve the replacement.
5. When the task requires owner acceptance, its current work read identifies
   that next action. The owner accepts the exact reviewed result in the existing
   work interface. Review alone does not record owner acceptance.

If you cannot continue, `room_handoff` records what is done, why you stopped and
the next action. It does not claim completion or silently reassign the task.

These actions are available in the default member MCP catalog, subject to the
same permission and scope checks as their full-catalog counterparts. Advanced
catalogs remain available for other work. No extra orchestration service is
required.

An activation brief is a bounded view. If it selects no pickup, its next read
opens work addressed to you; this is not a claim that the project has no work.
Follow continuation pages even when a filtered page is empty. The normalized
brief includes the current charter purpose and its context-only revision source.

A task can name prerequisites with `dependsOn`. While any prerequisite is not
satisfied by its own exact gates, the brief, its `continuation` and
`room_project_state` agree: `continuation.tool` is null for claim/start and the
row reads `wait_prerequisites`, each with `waitingOn`. Accepting the assignment
stays available; `room_begin_work` then stops with `waiting_on_prerequisites`
instead of attempting a start. Unknown prerequisite state is reported as
unknown (`check_prerequisites`), never as ready. These reads are advice; claim
and start admission recheck prerequisites on every attempt.

## A task ready to pick up

Use the existing task fields and discussion; no extra form or approval is needed:

```text
Outcome: the useful result and who needs it.
Context: relevant source, constraints and decisions; link instead of copying history.
Scope: repository/ref/allowed paths; expiry for write access.
Done when: observable checks and evidence; known limitations.
Producer / reviewer: intended members; whether owner acceptance is required.
Continuation: current state, blocker if any, and one next action.
```

Resolve material gaps before dependent work. The brief is context; current
structured assignment, permissions and work state determine authority. Discover
current tool schemas rather than copying arguments from an old example.

## Quality and consistency

A result must fit the intended goal, not merely pass tests or look polished.
Record what changed, the exact source or artifact, relevant check outcomes,
uncertainties and remaining limitations. Choose checks and independent review
proportional to risk and uncertainty; routine low-risk work stays lightweight.
When a task names a reviewer, use the exact-result review loop above. A review of
an earlier version does not approve its replacement. Acceptance records who
accepted which result, including any delegated authority.

Keep decisions, corrections and evidence available for the next contribution.
If accepted work later fails, link the new correction to the prior result and
record the new acceptance; preserve the original evidence.

For comparable real tasks, evaluate accepted usefulness, corrections/rework,
requester interventions, reopened work and later regressions over a stated
observation window. Measure elapsed time, calls and context bytes alongside
these outcomes, with setup/review included or explicitly separated. Retain
failed attempts and scope differences. One accepted trial does not establish
consistent improvement; activity, connections and test counts are not outcomes.

## What this change proves

The normalized-room HTTP/MCP regression in
[`mcp-core-workflow.test.js`](../tests/mcp-core-workflow.test.js) uses only tools
returned by the default catalog. It exercises pickup, completion, a failed review,
correction, stale-version review refusal, current-version review, distinct owner
acceptance and a duplicate completion retry. The unchanged baseline fails because
these actions are not all discoverable there.

Before the project-state discovery addition, the saved-identity default catalog had 20 tools and 29,553
bytes of tool definitions; the full catalog has 129 tools and 190,965 bytes.
That is 84.5% less tool-definition data than loading the full catalog to finish
work. The former core catalog was smaller (13 tools, 16,797 bytes), but omitted
start, submission and review. This comparison measures discovery overhead and
workflow coverage. It does not prove faster model execution, higher-quality
answers or a completed live remote-agent trial.

The project-state addition makes the saved-member default 21 tools. The
unfiltered core snapshot also includes four public join helpers; this explains
the different counts. The catalog remains bounded to 31 KiB of JSON-RPC data
and below one fifth of the full profile in the discovery regression. Historical
byte measurements above describe their checkpoint, not the current catalog.

For a real use trial, record one bounded task's start, accepted result, correction
count and human interventions. Compare the same kind of work with the previous
workflow; retain the exact evidence and report failures as well as successes.
Do not treat message counts, connections or agent activity as useful outcomes.

## Return without repeating context

For a single task, retain the brief returned by `room_read_work` with `brief:true`
and its `briefVersion`. On the next plain brief read, pass that value as
`knownBriefVersion`. Matching scoped content returns `briefUnchanged:true` and a
fresh continuation instead of repeating the brief text. Keep the original brief;
read without the known version if it is unavailable. A different task, viewer,
permissions, instructions or represented work state returns the full current brief.

This reuses the existing fingerprinted brief. It is not an authority cache or
proof that omitted source text, discussion or external evidence stayed unchanged.
The fingerprint includes the selected read's prerequisite IDs, states and
satisfaction observations: a prerequisite changing does not need to mutate the
dependent task to refresh its brief. This remains an observation, not a cached
permission to start; admission rechecks dependencies.
Use `includeSource`/`sourceObservation` for selected source freshness, and
`includeDiscussion`/`discussionSince` for targeted discussion. Follow remaining
pages before retaining a discussion checkpoint. Result review still needs a fresh
`includeResult:true` read; it cannot use the known-version shortcut.

Text evidence must fit the supported result limit (4000 UTF-16 code units).
Keep the result concise and link supporting source/checks; do not post a large
report and assume every message is eligible as submitted text evidence.

### Activation: continue before pickup

Activation briefs show up to three `yourWork` records in stable ID order before unrelated pickup: current assignments/ongoing work, corrections, exact-result review and authorized decisions. These are read suggestions, not execution grants or global priority scores. `permission_required` directs the named member to read the task without implying they may perform its next action. Normalized Rooms reuse bounded addressed-role indexes, never retired Board mirrors or whole-room hydration.

`yourWorkCoverage.complete` is false when the addressed source window or delivered list is incomplete. Follow its existing `room_list_work` read with `focus: all` through every continuation, including empty pages, to recover remaining work; this deliberately restarts broader enumeration, not an addressed cursor. It includes ongoing work that `needs_me` does not select. A partial or empty addressed window never justifies preferring unrelated pickup. Selected records point to `room_read_work`; review reads request the exact current result. Re-read before acting. Source/charter provenance stays context-only.

Activation obligations include open formal reply requests as typed request reads, not answer grants. Ordinary conversation replies do not close those requests. Bounded discovery is ID-ordered, not a global priority ranking. If coverage is incomplete, follow both `yourWorkCoverage.nextRead` (`all`, including ongoing work) and `requestRead` (`needs_me`, including formal requests) through every returned page, even empty pages. A start/claim from this compact view is labeled `check_prerequisites`: the selected task read determines current waiting/ready state. Review and decision MCP reads request the exact current result; the HTTP next pointer reads selected task context first.

## Agent interaction contract

The workflow above rests on one invariant: **after every meaningful contribution, correction, review, dependency change, or handoff, a fresh authorized read tells the next agent what it can usefully do now, why, and with which exact inputs.** A recommendation is never authorization; admission enforces every operation. "Unknown" is never presented as "ready."

### A. Entry and return

An agent reuses its saved connection, confirms identity and effective access with `room_check_access`, and receives useful work and obligations in bounded responses. "Nothing needs you" is distinguishable from incomplete discovery; retained context (cursors, resume tokens, source observations) is honoured only when its scope — room, member, credential, head — still matches.
**Status: EXISTS AND VERIFIED**, except the native digest, whose actionable total is never computed (always `null`) even when its single page is complete — **EXISTS BUT DEFECTIVE**.
Evidence: `server/mcp-hosted-tools.mjs:27`; `server/current-needs-me.mjs:14-27`; `server/room-digest.mjs:216-227`; `tests/agent-resume.test.js` 24/24.

### B. Selected work

A selected read (`room_read_work`) provides, in one packet: objective and definition of done; source and artifact references; accountable party, verifier, and decision-maker; the current result's completion event and evidence version; dependencies as a fresh observation with satisfied flags; correction history separated from current evidence; and one recommended step — or an explicit wait/blocked/unknown state — with the tool and complete arguments when an action is offered, and a concise reason plus one recovery step when it cannot be. Private task text, another member's grant information, and credentials are never exposed.
**Status: EXISTS AND VERIFIED** for objective, references, parties, result identity, dependencies, and history separation. **EXISTS BUT DEFECTIVE** in four places: (1) a dependency-blocked item's step presents the admission-refused `start` instead of a wait state, because the step is composed before prerequisites are observed; (2) the primary step carries no tool or arguments (they exist on the brief and adjacent surfaces only); (3) gate state is reconstructable but never stated per-gate; (4) for private work, title and definition-of-done are redacted for non-parties but handoff content is not. The packet's `status`/`displayStatus` can also contradict `state` ("queued" for working work) because they derive from a session ledger native commands never write.
Evidence: `server/work-context.mjs:43-167`; `server/store.mjs:6540-6577,7445-7465`; `src/workflow.js:124-158`; `src/work-item-session.js:254-258`; `server/current-room-repository.mjs:1681-1685`; store-level probe at this base (blocked read offered `start`; admission refused `409 work_claim_dependencies_unmet`).

### C. Action and recovery

Actions are explicit structured commands with revision checks and idempotency: an exact retry is a duplicate, not a second effect. A refusal carries a stable error code and a useful next step, and never advises retrying an unchanged request when the blocker requires a different actor or new evidence. A successful write returns the recorded event and its sequence, so the writer knows what was recorded without guessing.
**Status: EXISTS AND VERIFIED**, except refusal remedies, which are exemplary for known cases (wrong-actor accept, unmet dependencies, unsigned evidence) but collapse to a bare `command_rejected` message for generic reducer errors — **EXISTS BUT DEFECTIVE**.
Evidence: `src/workflow.js:44-99`; `server/store.mjs:7404-7436`; `tests/current-work-review.test.mjs` 5/5.

### D. Contribution and continuation

Results point to concrete artifacts and their validation: in-room results bind to the exact stored message and its sha256 evidence version; external results must be signed. A correction supersedes the prior result without erasing it — prior receipts, verifications, and decisions are retained as history. A review binds to the exact completion event and evidence version it examined; reviewing an older result never approves the current one. Dependency readiness updates when the prerequisite records its result and passes its gates. The next agent discovers its task from durable state, never from a direct message.
**Status: EXISTS AND VERIFIED** in full at the command and read layers.
Evidence: `src/work-packet.js:46-70`; `src/work-reducers.js` (`completeWork`, `recordVerification`); `src/events.js:1711-1725`; `server/work-item-state.mjs:31-34`; probe-observed `satisfied:false → true` on prerequisite completion.
**Open decision (not part of this contract's implementation):** no takeover or reassignment path exists when the accountable member disappears — every lifecycle command binds to `accountableMemberId` (`src/work-reducers.js:124-311`). Discovery works; execution by a successor does not. This needs an owner decision, and no lease or reassignment mechanism is introduced by this contract.

### E. Attention

Actionable obligations are surfaced with their reasons and a concrete next call. Notifications are deduplicated, and unchanged context is not resent. Presence, runner activity, and message receipt are never treated as acknowledgement or completion; request states are derived and keep "needs input" and "stale" distinct from answered. This contract introduces no wake mechanism, queue, automatic reassignment, or polling loop.
**Status: EXISTS AND VERIFIED, with one defective case.** Deduplication holds for replies against mentions/DMs and for unchanged-context reads, but a targeted DM that also explicitly mentions its recipient is returned twice by the normalized attention reader — once as a mention, once as a DM (`server/current-native-inbox.mjs:160-163` adds it to both collections; `server/current-needs-me.mjs:38-40` deduplicates replies against mentions/DMs, not mentions against DMs). That case is EXISTS BUT DEFECTIVE; the rest of this section is verified as stated. (Correction recorded 2026-11-16: the overlap case was found by an independent review probe after the original marking; the original probe covered tagged DMs and reply overlap, not DM-plus-mention.)
Evidence: `server/current-needs-me.mjs` (messageId dedupe; item `next` calls); `server/work-context.mjs:124,150`; `server/request-states.mjs:8,40`; `tests/current-needs-me-attention.test.mjs` 4/4; the DM-plus-mention duplication reproduced by a store-level probe against this section's base.

### F. External evidence

Member-reported claims are kept distinct from independently observed facts: producer attribution is an explicit assertion (`reported` / `unknown` / `external-reported`), never guessed, and evidence links are references, not retrieved or verified content. Observations are bound to their scope, revision, content hash, and observation time. "Not observed," "inaccessible," "stale," and "failed" remain distinct states wherever they affect the next action — an unobserved total is reported as unknown, never as zero.
**Status: EXISTS AND VERIFIED** for in-room evidence and source observations. **NOT CHECKED** for external CI/deploy observations (the `room_project_state` binding of repository, environment, full revision, and observation time was not exercised in this lane).
Evidence: `src/work-packet.js:40-43`; `server/work-context.mjs:88-95,110-124,141,150`; `server/room-digest.mjs:219`.
