# Agent onboarding and invitation recovery

September 7, 2026. Follow-up to [the previous testing round](TESTING-ROUND-2026-09-07.md),
using the follow-up section of [the testing plan](USER-TESTING-SYSTEM-2026-09-07.md),
written before this round's tests.

The existing client now has a complete write guide. Two fresh agents used it to
produce and independently review an original artifact without inspecting client
implementation or tests. Four invitation recovery defects were corrected. No
new production API, SDK, MCP transport, runner or Compute adapter was added.

## Final verification

Local uncommitted candidate on base
`69e820909876e2d1e0a4aba2fae60261255eec38`. Runtime/test fingerprint:
`efd425a62d97ff6ea7edd226d2b241ea66d31a6f98c98e62914da4aebedcab18`
across 89 files. Same sorted path/NUL/bytes/NUL procedure and exclusions as the
previous round; documentation, generated evidence and ignored private files are
excluded. Node 24.19.0, Playwright Chromium, isolated loopback fixtures.
Because the guide is an executable test input, its separate SHA-256 is
`882d2c1495ef04884da8f9641e6bc495fa7288ece7e2b274ead66c837638b42c`.

| Evidence | Final outcome |
| --- | --- |
| AUTO core/API and syntax | 200 passed; zero failed/skipped |
| AUTO browser | 52 passed; zero failed/skipped |
| AUTO local Cloudflare | 6 passed; zero failed/skipped; no deployment |
| SIM visual review | Six new screenshots inspected by root; four recovery screenshots also reviewed independently |
| AGENT producer and reviewer | Actual work and review with distinct permitted Room identities; no command failures reported |
| Human approval | Deliberately pending, confirmed by owner readback and browser |

Full-suite logs: `/tmp/room-onboarding-final-{core,browser,cloudflare}.log`.
The four guide tests and eleven recovery tests are included in these counts,
not additional participants or additive full-suite results.

## What changed

- [Agent write guide](AGENT-WRITE-GUIDE.md): connection, assignment/source lookup,
  accept/start/complete, exact artifact provenance, independent pass/fail,
  correction and blockers, latest revisions and exact-command retries. Seven
  literal JSON shapes and two JavaScript snippets are exercised by the new test.
  Fixture evidence is explicitly synthetic; that automated test does not claim
  real artifact retrieval or review.
- Clipboard completion checks the displayed link's identity as well as the
  current dialog/session. Success or failure for an older link cannot replace
  newer feedback or focus a hidden field.
- Interrupted invitation previews reveal Retry without restoring the secret
  into the URL. Network failures, 429 and 5xx can retry the same token. Repeated
  failure keeps useful focus without taking it from a newer control. Malformed
  and expired links do not advertise Retry. Preview never implicitly joins.
- Successful cancellation restores keyboard focus even if the list reload
  fails, without taking focus away from a deliberate move. The confirmed row
  immediately says cancelled. This last label defect was found by inspecting
  the screenshot after the initial eleven tests passed; explicit label
  assertions were added and all eleven reran successfully.
- The local artifact fixture now publishes the exact buffer it hashed, rather
  than rereading a possibly changed source file during copying.

Only Retry adds a visible control, and only in its relevant error state.
Successful normal flows retain progressive disclosure.

## Fresh-agent exercise

Two newly spawned agents had no prior task history. Each received the guide,
its own private fixture configuration, the installed runtime path, the local
network permission requirement and the authorized fixture publication/trust
procedure. The producer discovered the assignment and source through the Room;
the reviewer prepared its own rubric from the task before reading the receipt.
The named research brief was allowed. Implementation, tests, previous artifacts,
other role credentials and the producer's process were not.

Original artifact: [Dasha bridge acceptance cases](AGENT-BRIDGE-DOCS-ONLY-2026-09-07.md),
787 words, 5,939 bytes.
SHA-256: `97b52dd91487609c8da2bfa1bb9901114b30ebfa35698e4a92817b6cd922859e`.
Both agents retrieved the actual HTTPS bytes using the single fixture CA with
normal certificate/hostname verification. The reviewer found all six required
cases supported and recorded a genuine pass, not a prewritten verdict.

| Action | Event | Sequence / resulting work revision |
| --- | --- | --- |
| Accept | `3a328f77-6f2a-49e6-84ec-879af75abab8` | 7 / 1 |
| Start | `7192cb67-cb9a-4b72-9bbd-55abae6cc1c1` | 8 / 2 |
| Complete | `c8987199-2fc6-4e96-a5d6-6b73661b4fcb` | 9 / 3 |
| Review pass | `3e48dbac-5c32-4451-8f73-105ccdc072fc` | 10 / 4 |

Owner orientation, return brief and browser agree: `next.action = decide`,
designated owner, `decision = null`. Neither agent used an owner credential.
Sanitized evidence: `test-results/agent-docs-only-handoff.json`.

Both reported the guide sufficient for client usage, with no mistaken command,
failed action or blocking documentation ambiguity. Root supplied setup, not
implementation coaching. The reviewer's observation that its handoff filter
correctly excludes still-running work did not block reading source context via
the documented snapshot. This closes the prior AGENT-UX-01 finding for this
bounded test, not for all external agents.

## Screenshots and cleanup

Root inspected all six new images:

- `test-results/invitation-recovery-preview-error-touch.png`
- `test-results/invitation-recovery-preview-ready-touch.png`
- `test-results/invitation-recovery-clipboard-replacement-touch.png`
- `test-results/invitation-recovery-cancel-confirmed-list-error-touch.png`
- `test-results/agent-docs-only-owner-pending.png`
- `test-results/agent-docs-only-evidence.png`

Credentials were masked or absent. Touch is browser emulation, not a physical
phone test. The expanded work panel scrolls internally; one screenshot does not
show its entire receipt. Exact review evidence is also in the sanitized readback.

The disposable fixture at ports 58810/58811 was stopped after verifying its
exact process and listeners. Its three private role configurations and TLS
private key were removed and their absence checked. The isolated database,
public CA and immutable artifact remain under the temporary
`project-room-real-agent-7pIhUl` directory. Its loopback evidence URL no longer
resolves; the repository Markdown artifact and recorded hash remain.
Existing preview databases and hosted Room data were not changed.

## Limits and next work

Human journeys were simulated, not tested with human participants. Both fresh
agents share one vendor, host and orchestrator; separate members are not proof
of organizational independence. Setup and evidence hosting are still operator
prerequisites. No unattended adoption, cross-vendor compatibility, model
inference, billing, physical-device usability or production readiness is proved.

Remaining visual polish includes pluralizing the one-message count and testing
long titles/expanded evidence with actual users when requested. The next bounded
engineering slice remains a persisted fake-Compute submission/recovery adapter;
verify hosted Dasha's job contract with its owner before real integration.
Provider restore, budget alerts and the requested final domain route remain
separate deployment gates.

No commit, external publication, Dasha source change, paid use or deployment
occurred. Staging remains app `0e20615`, Worker
`5b052420-ec55-4fe3-8a35-7f0ac1347bcb`.
