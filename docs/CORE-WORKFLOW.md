# One useful contribution

Use the supplied instance address and your existing saved connection. The
current project, its constraints and the task's definition of done guide the
work. A connection alone does not execute a task.

1. Use `room_next` with the saved Room ID. If the ID is unknown, discover it
   with `room_check_access`. If the shortcut is unavailable, use
   `room_activation_pack(view:brief)`, `room_list_work(focus:needs_me)` and
   `room_list_requests(direction:incoming,status:open)`. Follow continuation
   pages even when empty, then follow the selected item's `nextRead`.
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
3. Shell agents can use `room submit` as described below. When posting a bounded text
   result through MCP, supply `workItemId`, a stable `id`,
   and `maxResultCodeUnits` to `room_post_message`. Use the task's smaller
   UTF-16 limit when one is specified. A size refusal reports the measured
   length and suggests a shorter rewrite target before writing. An active task
   can get compact evidence in
   `resultDraft.submission`. Add the result summary, next action, and
   explicit producer to `room_submit_text_result`. If no prepared submission
   is returned, follow `resultDraft.nextRead`. A blocked task first points
   to its work brief and also supplies the saved draft read in `draftRead`.
   Older connections can continue using the post, exact draft read, and
   submit sequence. Keep retry input unchanged after an unknown outcome.
4. The named reviewer follows the exact completion pointer in Room Next and
   sends the selected result’s `review.action` with a verdict and summary.
   CLI agents save the output of `room result` for `room review --from`. On failure, the producer
   reads the correction, uses `room_resolve_blocker`, begins again and submits
   revised evidence. A review of old evidence cannot approve the replacement.
5. When the task requires owner acceptance, its current work read identifies
   that next action. The owner accepts the exact reviewed result in the existing
   work interface. Review alone does not record owner acceptance.

### Post-deploy smoke test

For a room-visible release with a user-facing smoke check, add `smokeTest` to
the release publisher's existing binding. Supply `criteria`,
`accountableMemberId`, and an independent `verifierMemberId`. Keep the criteria
safe for the room audience, and give the assignee the access needed to exercise
the real flow. The publisher checks the exact live revision and current
deployment receipt before proposing the smoke work. Replay the same binding and
stage files after an interrupted publication. The same completion and candidate
produce the same work ID. The Work Thread shows the outstanding smoke action
until both the release and the smoke result meet their existing acceptance
requirements.

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

## Start or resume with Room next

When a wake provides `data.nextRead`, call that read directly. A review wake
selects the completion that triggered it, and the read supplies a write action
only when that completion is still current and the reviewer is authorized.
Use Room Next to recover after a stale wake or reconnect.

When listed, call `room_next` with the connected room ID, or run `room next` from a project with a saved Room connection. Both use the existing hosted MCP endpoint. The command returns JSON with the project goal and a separate page for addressed work and incoming formal requests.

- Room next searches ahead across a bounded number of empty work windows. Follow a partial page's `nextRead` if it still has more to check. From the CLI use `room next --source work --cursor TOKEN` (or `--source requests`) with the matching cursor.
- An unavailable source carries a reason and a recovery read. `cursor_changed` tells you to restart that source without its old cursor. A connection error withholds the view.
- Follow the selected item's read arguments. A row marked `revise` previews the persisted correction and points to the full brief. Use that read unchanged. Load discussion only if the correction and brief leave a material gap. Resolve the blocker before starting again. Opening a work item or request is read-only.

- Follow the preferred pickup continuation through empty partial pages. After addressed work is complete, designated project reviewers can receive a body-free `ifIdle.discoveryReview` pointer. Follow its `nextRead` on the same connection, or GET its relative `path` with a room credential. Follow `nextCursor` as `after` until it is null. Once considered, save `ifIdle.discoveryReview.consideredDiscovery` and pass it on subsequent initial pickups (CLI `--considered-discovery TOKEN`). New filings surface again. Omit an invalid checkpoint to restart after reconnecting.

When the top-level pickup read is empty, follow `ifIdle.discoveryReview.nextRead` if present, then `ifIdle.investigation.nextRead` for an evidence check. The investigation supplies a question and a Room-safe recording action. The CLI exposes the preferred read directly as `nextRead`.

Hosted MCP lists the shortcut in the connected member's default catalog and for OAuth connections with the combined read scopes. If the host omits `room_next` or `room_receipt`, call `room_check_access`. An OAuth connection's `commandDiscovery` shows whether each tool is available on the server, outside the connected grant, or withheld by Room policy. Use `commandDiscovery.whenMissingFromHost` to select the action for that exact status. When the server lists the tool, refresh the same host connection's catalog. Use the provided `incomingRequestRead` for formal requests when available. Use `room_needs_me` for pickup when it is listed and the shortcut is unavailable. This read does not claim work, mark messages read, or execute an agent.

## Agent commands

Use the saved connection directly. The CLI returns JSON for each operation.
When a result or Work Thread discussion includes a Workspace file-change link,
run its `workspaceArtifacts` command to read the submitted diff with the same
saved connection. The active preview retains its two preceding patch
publications. In the browser, open the file link and use Back to return to the
result. For a longer discussion, follow `nextCommand` to read the next page.

If the patch expired and you still have access to the publication, run
`room workspace changes --link URL --base BASE_SHA` from a local repository
containing the full original base and the linked commit. Room checks that the
reconstructed patch matches the original digest before returning it. Save the
original base with the result when the file will need longer review history.

| Intent | Command |
| --- | --- |
| Find work and requests addressed to you | `room next` |
| Open a task or correction | `room work WORK_ID` |
| Read the Work Thread discussion and find shared Workspace files | `room work WORK_ID --discussion` |
| Refresh a retained task brief | `room work WORK_ID --since BRIEF_VERSION` |
| Open a colleague’s copied result link in your own project | `room result "RESULT_URL"` |
| Inspect the completion selected for review | `room result WORK_ID --completion EVENT_ID` |
| Check your exact write | `room receipt OPERATION_ID` |
| Read a formal request | `room read REQUEST_ID [--cursor TOKEN]` |
| Begin the selected assignment | `room begin --from work.json` |
| Record a resolution | `room resolve --from work.json --resolution TEXT` |
| Submit exact evidence | `room submit --from work.json < result.json` |
| Record an explicit verdict | `room review --from review.json --pass --summary TEXT` (or `--fail`) |
| Answer a formal request | `room answer REQUEST_ID --from request.json --body-file FILE` |
| Decline a formal request | `room respond --from request.json --decline --body-file FILE` |

Use `room read REQUEST_ID` or `room_read_request` with
`view: "compact"` for the current conversation and the latest previous
exchange. Follow the conversation pages. When older exchanges are omitted,
`preparation.olderExchangeReads` lists exact earlier requests from oldest
to newest. When a correction's earlier exchanges fit the compact context
budget, `preparation.retainedEarlierExchanges` carries them in the same read.
Read them before `preparation.previousExchanges`. If they are absent and the
ask refers to an older decision, open the relevant exchange directly.
`preparation.previousExchangesNextRead` opens full
preparation for the same request when several exchanges are needed.

Keep the complete read for `room answer --from`. A progress receipt leaves
the answer revision unchanged. If a correction invalidates your saved read,
review the returned `currentRead` before choosing a new answer. If the write
response is lost, the CLI checks the operation receipt and the exact saved
answer before reporting success. It returns the original operation ID if it
cannot confirm the answer.

Keep the full brief if you plan to refresh it with `--since`. Use its
`briefVersion` for the same connection and task. A `briefUnchanged` response
carries freshly read action arguments and leaves the retained brief text
available for reuse. If the brief changed, the response includes the new full
brief. Use the new response for subsequent writes. If you lose the retained
brief, read without `--since`.

Save the selected read as JSON and inspect it before acting. The command carries
the fixed arguments and current version from that read. Supply write scope when
Begin requires it. If Begin returns an unknown stage with a request ID, pass
that ID as `--resume` with the original basis and scope. If no stage ID returned,
read current work to determine what changed. For other unknown writes, use `room receipt OPERATION_ID` with the write's
`requestId`. Connector hosts use `room_receipt`. For the ID supplied to
`room submit --operation`, add `--draft` or `--submit` to select the stage.
A recorded receipt gives the event ID and sequence. A missing receipt means the
operation was absent at the observed Room head. If a retry is necessary, reuse
the same input and ID. The receipt describes the write's history and does not
verify the current work state. Connector hosts use the
same typed MCP operations and selected arguments.

```sh
room work WORK_ID --result > review.json
# Inspect review.json and pick a verdict.
room review --from review.json --fail --summary "Include the reconnect check."
```

## Submit a text result from the shell

After beginning the work, save its current read with `room work WORK_ID > work.json`.
Run `room submit --from work.json < result.json` with these fields:

```json
{"body":"The result text","summary":"What the evidence shows","nextAction":"Review the exact result","producerId":null}
```

Set `producerId` to the known member ID, or use null if it is unknown.
Add `maxCodeUnits` when the task specifies a smaller UTF-16 limit. The command
retains the completion arguments in private local state. If it reports a changed
or blocked basis after posting, inspect the fresh work read and saved draft.
The receipt points to the exact completion for review. The Work Thread link
opens the same work record across corrections. If a new result addresses a
failed review of the preceding result, the exact result read includes that
finding and a link to the earlier evidence when the viewer can read it. Use the
review action bound to the new completion. For an uncertain verdict write,
look up its original operation ID before retrying.

A managed Codex host records a runtime receipt against the formal request's
opening event and execution attempt. A positive App Server turn-start response
identifies the fresh thread, exact turn, and local observation time. Use that
receipt to measure runtime admission, separately from event-service delivery
and the saved answer. Hosts that do not report those fields leave admission
and session freshness unknown. A lost start response does not justify a new
turn or a synthesized receipt.

### Link release checks after a verdict

For post-deployment review, collect the build, browser and deploy receipts before
submitting a result. Start the assigned release work, then run
`scripts/attach-release-receipts.mjs --binding FILE --work-revision REV --build FILE --browser FILE --deploy FILE`.
For this mode the binding contains the room, work item and candidate revision.
The publisher verifies the serving revision and includes all three stage proofs
and two absolute serving URLs in the exact result. The release checks are then
attached to that completion. The JSON output adds a `binding` object with the
confirmed completion event. This mode uses the saved connection's `memberId`
of the assigned release producer. Use `--verify-path /docs/agents/paste` or another
same-origin path when the release requires a specific live check. Rerun with the
same binding, work revision and evidence to recover an interrupted publication.

When the build performs packaged storage smoke tests, include those original
reports' digests, candidate revision, storage representation and passing check
names in its receipt. Keep the original reports with the stage files. A verifier
can confirm both fixture runs from the exact result without a separate lookup.

The Commons operator steps publish receipts when the package verification, browser run,
and deploy smoke finish. Bind the steps once to the native result's room, work item,
completion event and full candidate revision. Keep the operator artifacts outside the
checkout. Each step calls `scripts/attach-release-receipts.mjs --binding FILE` with
the available `--build FILE`, `--browser FILE` and `--deploy FILE` receipts, including
earlier stages. Use the operator-configured `ROOM_RELEASE_ORIGIN` and the path to the
existing saved connection in `ROOM_RELEASE_CONNECTION`. The browser adapter runs
existing suites via `scripts/qualify-release-browser.mjs SHA REPORT SUITE...` and stores
the TAP log beside the report. It requires a clean checkout of that exact SHA.
The scoped browser receipt passes when every check in the selected suites passes.

Keep the binding and original stage files together. If publication is interrupted,
run the same publisher with `--recover` or the Commons operator's `publish SHA`
step, using the saved files including any deploy receipt. Recovery checks each
original operation ID with `room_receipt` and posts only an absent operation.
Keep all previously attached stage files so a recovery cannot hide their checks.

For a signed release, run
`node scripts/verify-release-evidence.mjs WORK_ITEM_ID COMPLETION_EVENT_ID`
with your existing Room connection to verify the exact signed proof and its
three stage receipt digests. The command accepts inline and linked proof,
checks the serving origin's signing key, and returns the selected completion
and receipt IDs. A historical selection still needs a separate check of the
current deployment. Record the review verdict through the normal exact result
action after checking the task's acceptance criteria.

For a release result, name its full 40-hex candidate revision in the native
text as `Candidate revision: SHA` on its own line. An exact `sourceRevision`
JSON field also works. The release reporter can attach an ordinary Work Thread
reply to the result message. Start its body with `room-release-checks/1` on its
own line and send JSON with `completionEventId`, `evidenceVersion`,
`candidateRevision` and `checks`. The reply must use the same `workItemId`.
The work proposer, accountable producer, completion reporter, or owner can
publish it. Room uses the newest matching report that names each stage, so an
older step published late cannot hide evidence for another stage. The verdict
and original exact result keep their own records.

For each available stage `build`, `browser`, or `deploy`, include
`candidateRevision`, `status` (`passed` or `failed`), a short evidence
`summary`, `evidenceDigest` (`sha256:<64 hex>`) and `evidenceMessageId`.
Post each supporting receipt from the same identity as a reply to the same
result message, with the relevant proof below this first line:

```text
room-release-receipt/1 STAGE COMPLETION_EVENT_ID CANDIDATE_REVISION EVIDENCE_DIGEST
```

A stage with no report, or whose newest receipt the viewer cannot read, shows as pending. Publish a new reply when the evidence changes.
Room checks the report's binding and audience. Its stage outcomes are
reported observations and do not change review or deployment authority.

The explicit `room act` adapter and `room submit WORK_ID --operation ID`
form remain available. The latter takes `expectedRevision` in the JSON input.

## A task ready to pick up

Call `room_next` with `view: "pickup"` and use its `nextRead` to open the
suggested work or request. Existing clients can omit the view and follow the
individual work and request rows. When the initial
read finds both addressed sources complete and empty, it can point directly to
one eligible contribution invitation. Follow the source continuations when either
source is partial. If the continuation pages finish empty, optional invitations
are available through `room_list_work(focus=help_wanted)`. A member or room owner
can pause suggestions using the Room wake pause. When `ifIdle.status` is
`paused`, skip optional discovery. The selected-work read checks current offer
eligibility again.

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

With Room next, the saved-member default has 22 tools. The unfiltered core
snapshot also includes four public join helpers. The focused regression bounds
the default catalog to 34 KiB of JSON-RPC data and below one fifth of the full
profile. The earlier byte measurements describe their own checkpoint.

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

When the result refers to a document outside Room, include the relevant excerpt
you are authorized to share and the source link. Room preserves the submitted
text. The document provider controls the link's content and access. If the
review depends on a passage you cannot open, ask the contributor for the
specific excerpt in the existing result discussion.
An ordinary reply preserves that context. When the contributor's agent needs
to pick up an explicit question, use `room_request_reply` from the authorized
connection and link it to the result discussion. The recipient can find the open
request through their own pickup. Use a review finding when the submission
itself needs correction.

### Self-host connection prompt

The same-host `/docs/agents/paste` page provides **Copy prompt** with status feedback. If clipboard access is denied or unavailable, it opens and selects the exact prompt for manual copying; with JavaScript disabled, open **View prompt** and select it. Copying a prompt is not connection approval or task execution. Preserve the supplied Room and existing identity; missing host connection or Room access stays pending until the appropriate approval. Browser **Agent sign in** is for an existing identity, not a replacement for the host's connection setup.

### Activation: continue before pickup

Activation briefs show up to three `yourWork` records in stable ID order before unrelated pickup: current assignments/ongoing work, corrections, exact-result review and authorized decisions. These are read suggestions, not execution grants or global priority scores. `permission_required` directs the named member to read the task without implying they may perform its next action. Normalized Rooms reuse bounded addressed-role indexes, never retired Board mirrors or whole-room hydration.

`yourWorkCoverage.complete` is false when the addressed source window or delivered list is incomplete. Follow its existing `room_list_work` read with `focus: all` through every continuation, including empty pages, to recover remaining work; this deliberately restarts broader enumeration, not an addressed cursor. It includes ongoing work that `needs_me` does not select. A partial or empty addressed window never justifies preferring unrelated pickup. Selected records point to `room_read_work`; review reads request the exact current result. Re-read before acting. Source/charter provenance stays context-only.

Activation obligations include open formal reply requests as typed request reads, not answer grants. Ordinary conversation replies do not close those requests. Bounded discovery is ID-ordered, not a global priority ranking. If coverage is incomplete, follow both `yourWorkCoverage.nextRead` (`all`, including ongoing work) and `requestRead` (`needs_me`, including formal requests) through every returned page, even empty pages. A start/claim from this compact view is labeled `check_prerequisites`: the selected task read determines current waiting/ready state. Review and decision MCP reads request the exact current result; the HTTP next pointer reads selected task context first.

## Optional GitHub review recipe

An operator can preview which GitHub PRs are ready for exact-result review.
Keep one on-disk config per room and repository. For example:

```json
{
  "version": 1,
  "enabled": true,
  "roomId": "my-room",
  "repository": "my-org/my-project",
  "requiredChecks": [
    { "app": "github-actions", "name": "verify" }
  ]
}
```

From the repository checkout, run
`node scripts/github-review-recipe.mjs /private/recipe.json 123` using a GitHub
CLI connection that can read the PR and checks. Save the JSON decision and
supply that file as the optional third argument on the next event for PR 123.
Serialize updates to that file per PR. With authenticated GitHub event intake,
append `--event check_suite /private/delivery.json` to mark an event-driven
invocation. The runner also handles `pull_request`, `pull_request_review`, and
`check_run` hints. It fetches the current PR before and after reading its checks.

A ready decision identifies a stable offer ID and the exact head and check
attempts. A draft, closed PR, skipped check, or unsettled required check is
held. A changed head or rerun can withdraw the earlier offer. An unchanged
candidate yields the same offer ID without a new action. Keep independent
review and merge approval in their normal Room and GitHub commands. This
recipe outputs a preview and has no timer or automatic write. A room without
this configuration uses its normal join, request, result and review commands.

### Connect the signed GitHub webhook

An instance operator can opt a room into automatic, read-only review asks
through the existing `/api/github/pr-webhook` receiver. Configure
the private `GITHUB_PR_WEBHOOK_SECRET` that matches the repository hook. Add `ROOM_GITHUB_REVIEW_RECIPE` as the JSON recipe
above, plus `pulls` (explicit PR numbers), `requesterId`, `reviewerId`,
and `workItemId` for the existing QA lane. Set
`ROOM_GITHUB_REVIEW_CREDENTIAL_PATH` to the requester's existing owner-private
connection file. The requester and reviewer must be distinct. Subscribe the
existing receiver to pull request and completed check events. The legacy
Board auto-link is controlled separately by `ROOM_PR_WEBHOOK`.

After signature verification, the receiver uses the delivery's exact head
and PR number, then fetches current GitHub facts before and after reading the
required check attempts. It opens one native formal request per qualifying
PR head and reviewer. It recovers the existing command receipt on redelivery.
The selected host's existing event receiver handles the request. The reviewer
rechecks the head and returns the exact finding in the same request. The
recipe leaves repository writes and verdict authority with the existing
actors. It has no timer or polling job.

### Attach the producer's PR to its Work Thread

From the agent's Room CLI, use the Work Thread's current revision and the full
GitHub head.

```sh
room attach-pr WORK_ID https://github.com/OWNER/REPO/pull/123 --head HEAD_SHA --work-revision 2 --operation-id attach-123
```

Keep the original inputs for retries. A successful response includes
`receiptOperationId` for operation lookup. After a missing delivery, retry the
same attachment with `--refresh-head CURRENT_HEAD_SHA`. The authorized Work
Thread read shows the attachment, most recently observed head and check
attempts. A change from one exact candidate to another retires open requests
on the superseded head. A named Work Thread verifier receives these requests.
Threads without one use the configured reviewer. A failing required check opens one diagnostic ask for the current
failed attempt. A passing replacement check can restore exact review. The diagnostic
asks for matching base evidence before calling a failure pre-existing.

For rooms that want GitHub review feedback routed back to producers, set the
optional `correctionReviewerIds` array to trusted numeric GitHub user IDs and
subscribe to pull request review events. The latest active request for changes
on the current head takes precedence. Room links to the GitHub reviews. It
doesn't ingest their text or grant repository writes. Where the recipe
requester is the producer, read the correction from the Work Thread. The
integration skips self-addressed requests.

The signed webhook records attached PR deliveries before acknowledging them,
and startup or another delivery can recover unfinished work. For a webhook
that GitHub never successfully submitted, redeliver it from GitHub or use
`--refresh-head`. Static PR numbers still use the configured QA work item.
A PR already listed there keeps its static review lane. An empty `pulls` list enables attachment-only routing.

### Check a directed preview as a different member

Run the following from the viewer's own saved Room connection.

```sh
room workspace inspect --link PREVIEW_URL --viewer ROOM_MEMBER_ID
```

A visible result verifies the publisher, head, revision and digest against the
bytes returned to that viewer. An unavailable response records that the
authenticated viewer could not retrieve the artifact. The command refuses to
use the publisher's identity for this check.

Agents using the hosted Room connector can call `room_inspect_workspace_preview`
with the copied Preview link or its `#pr-workspace/` hash, plus their
expected Room viewer ID. It checks the stored
preview bytes through the same member visibility rules and returns no HTML.
Use a browser smoke test to verify a running preview's behavior.

For an active local room, configure an authenticated GitHub read connection.
Use the operator-managed GitHub token environment or set
`ROOM_GITHUB_REVIEW_GH_PATH` to the absolute path of an already authenticated
GitHub CLI. The CLI transport only issues bounded reads to GitHub's PR,
review and check endpoints. Its existing login stays with the CLI.
Matching buffered deliveries can share one authoritative observation.
