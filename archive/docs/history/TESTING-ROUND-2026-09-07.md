# Testing round: quiet invitations and real agent handoff

September 7, 2026. Executed after [the plan](USER-TESTING-SYSTEM-2026-09-07.md)
and [Darkbloom research](DARKBLOOM-COMPUTE-ROOM-2026-09-07.md) were written.
Human journeys were simulated; no human participants or satisfaction metrics.
Two actual orchestrator-started Codex agents performed the producer/reviewer work.

## Candidate and result

Local, uncommitted candidate on base
`69e820909876e2d1e0a4aba2fae60261255eec38`. SHA-256 fingerprint of 87 runtime/test
files: `7ac239c04f9b35e1c25031828d330a887a16ea4a43f446f26857f79681ce84cd`.
Sorted relative path, NUL, bytes, NUL were hashed for each non-ignored file under
src/server/client/scripts/tests/cloudflare plus index.html/package.json/lockfile.
Docs, generated evidence, ignored credentials, databases and dependencies are
excluded. Node v24.19.0; Playwright Chromium; disposable loopback fixtures.

| Evidence | Outcome | Scope |
| --- | --- | --- |
| AUTO core/API | 196 passed; zero failed/skipped | Final source syntax and service contracts |
| AUTO browser | 41 passed; zero failed/skipped | Final desktop, touch-emulated, keyboard, enlarged-text and recovery scenarios |
| AUTO Cloudflare | 6 passed; zero failed/skipped | Local Workers storage, HTTP and browser compatibility; no deploy |
| SIM visual review | Screenshots inspected; stale invitation progress label found and fixed | Expert simulation, not human comprehension proof |
| AGENT producer | Original 873-word artifact submitted through client | Actual task reading, acceptance, start, work and completion |
| AGENT reviewer | Exact artifact fetched, hashed and reviewed; pass recorded | Separate agent identity; same vendor/host/orchestrator |
| Owner decision | Pending, deliberately untouched | No simulated decision presented as John's approval |

Final logs: `/tmp/room-testing-system-final-{core,browser,cloudflare}.log`.
Earlier pre-final complete round also passed 196/41/6. These are separate runs,
not additive coverage or a count of people. Staging is unchanged at deployed
app `0e20615`, Worker `5b052420-ec55-4fe3-8a35-7f0ac1347bcb`.

## Changes verified in this candidate

- Invitation creation opens with one action and a compact defaults summary.
  Limits and management are opt-in disclosures; actual retained values drive
  the summary. Successful creation focuses Copy and hides the creation form.
- Creation/copy feedback is separate from list/cancellation feedback. An old
  list response cannot replace a newer list or erase “Link copied.”
- Hidden invalid limit fields reveal themselves and receive focus. Creation
  locks relevant inputs; lost-result retries reuse the exact original request.
- Cancellation clears the currently displayed secret, refreshes state and
  restores useful keyboard focus when its old control disappears.
- Guest entry shows audience, unverified names and temporary browser access.
  Detailed permissions/invitation expiry stay expandable. Same-room invitation
  return keeps the existing identity and draft.
- Healthy connection text is short; full connection limitations remain in
  accessible Details. Interruptions still visibly warn about stale history.
- Initial invitation preview no longer leaves “Checking session” and
  “Connecting” running indefinitely. It states that the Room is not open.

## Findings and corrections

| ID | Observation | Disposition |
| --- | --- | --- |
| UI-01 / P2 | Invitation list and creation shared a status channel; late results could erase newer feedback | Separate status ownership and response ordering; targeted browser proof passed |
| UI-02 / P2 | Progressive limits need explicit recovery when native validation rejects a collapsed field | Open and focus the invalid field; desktop/touch proofs passed |
| UI-03 / P2 | Screenshot and startup branch showed indefinite session progress behind an invitation | Corrected labels; explicit assertions added; full final suites passed |
| TEST-01 | First focused run checked status before the asynchronous dialog-close handler ran; desktop failed, touch passed | Corrected the test to await the specified resulting state, without weakening its assertion; rerun 2/2 passed |
| SETUP-01 | Operator initially supplied HTTP evidence while Room requires HTTPS | Replaced only disposable fixture before agent writes, with HTTPS and fixture CA; application policy unchanged |
| AGENT-UX-01 / P2 | Producer needed implementation/test examples to construct write commands | Open: add a short, complete client write guide and explicit schemas before broader external-agent testing |
| SETUP-02 | Agent shells lacked Node on PATH and default sandbox denied loopback access | Used explicit bundled runtime and scoped escalation; environment friction, not a Room authorization failure |
| TEST-02 | Screenshot helper selected a repeated work title rather than its heading | Scoped selector to work heading; capture succeeded; no application behavior changed |

The producer also corrected its own snapshot array lookup while retrieving the
replacement fixture's source message. Its draft began during the operator pause
and was finalized after accept/start. Therefore this is not an unaided cold-start
benchmark or a measurement of working time. No P0/P1 was observed in this bounded
round; this does not establish that none exist elsewhere.

Visual hypotheses remaining: long room titles can put Close on a separate row;
expanded evidence can require internal scrolling; the local-only invitation
warning adds substantial copy but is hidden on hosted origins. Do not infer that
these caused actual human confusion. Keep future fixes inside existing controls.

## Actual Dasha development work in a Room

Room title: Dasha Compute — Agent Test. Source: `bridge-research-task`.
Work: `dasha-bridge-acceptance`. Operator account explicitly named
“Test operator (not John).” Producer and reviewer have separate permitted keys.

The producer retrieved the task through RoomAgentClient, then created the
[acceptance matrix](AGENT-BRIDGE-ACCEPTANCE-2026-09-07.md). Its six cases are
proposals, not executed Dasha integration tests. They cover context permission,
duplicate submission, uncertain outcome, cancellation, exact review and unknown
usage/cost. The proposed next slice is a durable-attempt ledger with fake Compute
submit/lookup, before any external inference.

| Action | Command / event | Sequence and revision |
| --- | --- | --- |
| Accept | `producer-accept-20260907-v1` / `a765566b-ae05-4a29-b359-88e5440ee2f0` | 7; 0 → 1 |
| Start | `producer-start-20260907-v1` / `b3f7babb-2a15-49d9-80f2-1f04681e624c` | 8; 1 → 2 |
| Submit | `producer-complete-20260907-v1` / `8c6b246c-48c8-463d-b97d-0d73cf727d76` | 9; 2 → 3 |
| Review pass | `fc92c7d4-2040-4bc1-952e-0e04ce8d5744` | 10; 3 → 4 |

Artifact: 6,260 bytes; SHA-256
`fd474bae3a1b226fd216489ed5beb6c7c1553714b505a3e6998b4666ad4c2b52`.
Both agents retrieved real HTTPS bytes using the fixture CA with hostname and
certificate validation enabled. No global trust bypass. The reviewer judged
the content against the source brief; its verdict was not prewritten by root.
Owner orientation and return brief agree that the next action is `decide`, while
the actual decision is null. Room's distinct-member independence check is not
cryptographic runtime identity or organizational independence.

Sanitized readback: `test-results/real-agent-handoff.json`. New screenshots:
`test-results/quiet-invite-{desktop,touch}-{start,copy,join}.png`,
`test-results/real-agent-owner-decision-pending.png` and
`test-results/real-agent-evidence-review.png`. Selected invitation, mobile/work
and both actual-agent screenshots were viewed. Invitation secrets were masked.
Touch screenshot keyboard hints are not physical-device evidence; the behavioral
tests run before screenshot capture can alter emulation.

## Handoff and limits

The fixture is test infrastructure, not a new production artifact service.
After capture, stop its exact processes and remove temporary role credentials
and TLS private key; retain the isolated database, immutable artifact copy and
sanitized evidence. The loopback evidence URL then stops resolving; the Markdown
artifact and hash above remain available for review. Existing previews and
staging data are untouched.

No Dasha code changed, no model ran through Compute, no paid usage, no MCP
integration, no external publication and no deployment occurred this round.
Next useful work: improve agent write onboarding, verify hosted Dasha's recoverable
job contract with its owner, then build the bounded fake-Compute bridge slice.
Human usability and physical-device validation remain unmeasured, as requested.
