# Project Room testing system

September 7, 2026. Written before the next test round. John selected simulated
human journeys and actual agent testing for now; no recruitment, human study,
outbound invitations, session recording or participant payments are planned.
This replaces the immediate human-pilot plan in FIRST-USE-TESTING-2026-09-07.md,
without changing the historical evidence in that file.

## 1. Decisions this round should support

The product should make conversation → useful work → review feel straightforward,
while surfacing permissions and complexity when they matter. We need evidence
for these decisions, not a larger inventory of features:

| Question | Observation sought | Decision affected |
| --- | --- | --- |
| Can a guest join and contribute without learning our object model? | Visible entry point, short audience/lifetime explanation, usable composer | Keep or simplify first-use flow |
| Can an owner invite with defaults and adjust limits when needed? | Creation/copy succeeds; hidden validation and cancellation remain reachable | Accept or revise invitation disclosure |
| Can someone turn a suggestion into accountable work? | Source, assignee, definition of done and review choice remain intelligible | Keep one focused work dialog |
| Is status truthful under delays and interruption? | Connection is not a read receipt; retry does not duplicate; draft survives | Release or block affected flow |
| Can an actual agent understand and complete an assigned task? | Agent retrieves its assignment, creates original work, submits evidence | Assess real client usability beyond scripts |
| Can another agent review that exact result? | Separate identity, retrieved evidence, version-bound judgment, clear next owner | Accept or revise handoff contract |
| Can Dasha development happen in a Room before integration? | A useful development artifact moves through the same workflow | Choose first dogfooding task; do not claim Compute runs |

## 2. Evidence categories — never merge the counts

**SIM: simulated human journey.** An agent operates or inspects the interface
from a stated persona and task. Records actual UI behavior plus explicitly
labeled hypotheses about discoverability. It does not measure human confusion,
enjoyment, comprehension, conversion or time savings. Familiarity with the code
is a limitation, even with a fresh browser.

**AUTO: deterministic regression.** Scripts prove specific assertions for a
fixture, build and environment. Synthetic agent accounts are not actual agent
execution. A script that posts “completed” proves only the workflow accepted it.

**AGENT: real agent-operated work.** A running model-based agent reads its task
from Project Room, chooses and creates substantive output, and uses the real
client to submit it. A separate running agent retrieves and judges that version.
The harness may create accounts/tasks and capture evidence, but must not write
the agents' output or preselect the review verdict. Label these agents as
orchestrator-started; no claim of self-discovery or unattended wakeups.

**HUMAN: observed human session.** Out of scope this round. Zero participants;
no invented quotes, ratings, assistance levels or completion percentages.
Physical-device, assistive-technology and human comprehension remain unknown.

## 3. Scope and fixtures

Record date, operator, exact commit, dirty candidate fingerprint, fixture name,
role, browser/version, viewport, touch emulation, relevant feature settings,
scenario IDs and evidence paths. Fingerprint tracked/untracked source changes,
excluding credentials, databases, dependencies and generated output. Freeze the
candidate during a run; a fix creates a new candidate and a new result record.

Current deployed baseline is app `0e20615`, Worker version
`5b052420-ec55-4fe3-8a35-7f0ac1347bcb`. Quiet-invitation changes are a local,
uncommitted candidate until separately verified and deployed. Do not combine
baseline hosted results with the candidate's local results.

Use fresh loopback-only databases and separate owner, guest, producer and
reviewer identities. Never clear the user's previews, cookies, drafts or hosted
records. Fault injection, expired links and controlled lost responses belong
only to these disposable fixtures. Credentials stay in restricted temporary
files or process memory and are absent from evidence, URLs and logs.

Human simulations cover desktop 1360×900 and touch-emulated 390×844, keyboard
focus and 200% text. Touch emulation is not a physical-phone test. Capture can
change browser emulation, so assert keyboard behavior before screenshot capture.

Real-agent work uses one room, one bounded read/analysis task, distinct
credentials and a resolvable versioned artifact. Agents may read authorized
public source/docs and write only their own test artifact. No remote inference,
provider enrollment, secrets, payments, GitHub changes or production execution.
Keep the final human decision pending; the operator must not impersonate John.

## 4. Scenario matrix

| ID | Persona and neutral objective | Observable completion / failure |
| --- | --- | --- |
| SIM-01 | New guest: join and suggest a small task | Guest identity; message visible once; composer usable; audience and eight-hour access boundary available |
| SIM-02 | Owner: let a colleague join | Defaults visible without a settings wall; link created and copied; secret not retained after closing |
| SIM-03 | Owner: allow three joins for one hour, then withdraw access for future joins | Accurate retained settings; invalid hidden field revealed; cancel confirmation and sensible focus |
| SIM-04 | Owner: turn the suggestion into work someone can finish | Editable source title, eligible assignee, explicit reviewer choice; no automatic review downgrade |
| SIM-05 | Returning participant: find what needs attention | Current identity and work next step agree; recorded completion is distinct from review/approval |
| SIM-06 | Keyboard/touch user: send and edit a message | Desktop Enter sends, Shift+Enter adds line; IME/repeats guarded; touch Return preserves intended behavior |
| SIM-07 | Participant: recover after an interrupted action | Draft retained; uncertain result described; retry reuses command; no duplicate action |
| SIM-08 | Guest: open expired/full/cancelled invitation | Clear refusal, reachable recovery, no accidental identity replacement |
| SIM-09 | Enlarged-text user: invite and create work | Main actions remain reachable, no critical horizontal clipping, dialogs scroll |
| AGENT-01 | Producer: retrieve an assigned development brief | Uses orient/snapshot/brief; identifies own permissions and source; explicitly accepts/starts |
| AGENT-02 | Producer: create useful evidence | Original artifact satisfies task criteria; version/hash and actual producer recorded through command API |
| AGENT-03 | Reviewer: decide whether the exact artifact meets the brief | Retrieves assignment/evidence independently; checks hash/source and records pass/fail with reasons |
| AGENT-04 | Returning producer/operator: recover handoff context | Changes/brief and current state agree; no false human approval or independent-runtime claim |

Run ordinary success paths separately from interruption paths. Do not inject
failures into every first-use simulation and then generalize that experience.
For each simulation, attempt the goal from rendered UI before consulting source
for diagnosis. Scripted selectors and code inspection are useful but are AUTO
or expert evidence, not evidence of unaided discovery.

## 5. Execution sequence

1. **Plan checkpoint:** save this document and the Darkbloom brief; capture the
   candidate identity and fixture scope. No new tests precede this checkpoint.
2. **Focused candidate checks:** invitation disclosure, validation, lost-create
   retry, late-list response ordering, clipboard rejection, cancellation focus,
   same-member draft continuity and healthy/disconnected connection details.
3. **Simulated human review:** inspect saved desktop/touch screenshots and
   rendered states. Note noise, hierarchy, action visibility and accessible
   labels. Record hypotheses separately from reproduced defects.
4. **Actual agent handoff:** provision an isolated Room; post a bounded useful
   task; start a producer with only its role configuration and permitted docs;
   then a separate reviewer. Both use Project Room, not human content forwarding,
   for the assignment and result. Preserve their natural findings and interventions.
5. **Regression verification:** run core/API, complete browser and Cloudflare
   compatibility suites after any source changes. A suite that did not start,
   skipped required coverage or exited without tests is not a pass.
6. **Readout:** reconcile outcomes, screenshots, agent artifact and event
   receipts. List fixes separately from proposals and remaining gaps. Publication
   and deployment are separate actions, not implied by a local pass.

## 6. Actual-agent task and evidence contract

First task: produce a concise acceptance matrix for the proposed Dasha Compute
Room bridge using the research brief and requirements posted in the Room. The
matrix must cover selected context/permission, duplicate submission, unknown
outcome, cancellation acknowledgment, exact output review and missing usage/cost.
It must distinguish proposed behavior from implemented behavior, and identify
one practical next implementation slice. This is useful Dasha development work,
not a fake inference result or a paid Compute call.

The operator creates the work item and source message, not its answer. Producer
reads source through its own client and may inspect the specified local brief.
It publishes an original small Markdown artifact at an authorized loopback
evidence location and supplies its exact hash/version in the receipt. Reviewer
gets its own credential, reads the work from the service, retrieves the artifact,
checks its bytes and evaluates criteria independently. Review can fail; do not
force an agreeable result. Correct and resubmit through the ordinary workflow
if needed. A local content-addressed evidence URL is test infrastructure, not a
new production attachment service or a universally reachable artifact.

Record agent/orchestrator identity, source-message IDs, stable command IDs,
event IDs/sequences, revisions, output hash, artifact, review reasoning and
remaining next action. Report setup/help explicitly. Same-vendor agents and a
shared host are not organizational independence or cryptographic identity.
HTTP success does not prove MCP compatibility. No MCP adapter exists yet.

## 7. Finding record and prioritization

Each finding contains: ID; evidence category; candidate; scenario/role; expected
behavior; actual observation; minimal reproduction; artifact path; impact;
severity; confidence; affected scope; proposed smallest fix; owner; retest result.
Separate observation (“copy confirmation disappeared after list response”) from
interpretation (“could encourage repeated creation”) and remedy.

- **P0:** wrong access/attribution, private-data exposure, consequential duplicate
  action or false authorization. Stop the affected scenario and preserve evidence.
- **P1:** a core task or recovery path is blocked, or meaningful user work is lost.
  Blocks readiness of that flow.
- **P2:** recoverable confusion, inaccessible secondary action or substantial detour.
  Fix or explicitly accept before expanding the pilot.
- **P3:** localized cosmetic/copy polish. Fix only when it improves the core flow.

Severity is impact, not certainty or vote count. Mark suspected issues as
hypotheses until reproduced. Record pass/fail/blocked/not-run/not-applicable for
each scenario; never convert a missing test into success. Counts apply only to
the named cases, not the probability that a person will succeed.

## 8. Evidence and simplicity rules

Capture entry, decision, error/recovery and outcome states when useful—not every
click. Mask access keys and invitation tokens before capture. Keep synthetic
screenshots and sanitized logs under ignored test-results; store durable summaries
and useful non-sensitive artifacts in docs. Do not publish bearer links or private
browser state. A failed run is retained with its corrected rerun, not overwritten
in the narrative. No analytics SDK or background monitor is introduced.

Prefer fixing the existing control/state over adding another screen. Preserve
safe defaults and make advanced controls findable when needed. Short copy still
must communicate audience, irreversible effects and material cost. Icons need
accessible names; hidden settings must open when their validation fails.

## 9. Exit criteria and limits

Local candidate is ready for the next pilot only when required suites pass with
nonzero coverage, no open P0/P1 affects the tested core flow, focused regressions
cover fixes, screenshots have been inspected, and real-agent receipts agree with
the actual artifact and review. Pending human approval remains pending.

This does not establish human usability, physical-phone/accessibility compliance,
cross-vendor agent interoperability, unattended operation or deployed Dasha
integration. Provider restore, budget alerts and domain integration remain separate
production gates. Those unknowns are not erased by many local assertions.

## Follow-up round: agent onboarding and recovery

Planned before the follow-up executions: add a concise write guide using only the
existing Room client, test the guide's literal commands, and give a fresh producer
the guide plus an isolated task without implementation/test source coaching.
Reuse the same bounded Dasha-analysis task, with a new artifact file and separate
reviewer. Count any setup/help; do not treat same-model success as human usability.

Focused UI additions: delay clipboard completion past replacement of the displayed
link; fail invitation preview then retry in the same dialog; confirm cancellation
but fail list refresh. Verify current feedback, exact token/request reuse and
keyboard focus without stealing a newer focus. Run only in disposable fixtures,
save failure/recovery screenshots, then rerun full suites on the final candidate.
Existing staging, previews and Compute remain untouched.

## Method sources

The task-first, neutral-objective approach is informed by
[GOV.UK usability testing guidance](https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing).
Here it is deliberately adapted to simulations, not represented as a human study.
Prioritizing impact and persistence of problems is informed by
[Nielsen's severity guidance](https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/);
the P0–P3 labels above are our internal release convention. Source-bound test
evidence and strict separation of simulated versus actual execution are also
captured in [the Darkbloom research brief](DARKBLOOM-COMPUTE-ROOM-2026-09-07.md).
