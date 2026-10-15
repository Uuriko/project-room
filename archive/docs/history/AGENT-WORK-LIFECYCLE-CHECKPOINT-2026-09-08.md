# Agent work lifecycle: local checkpoint

September 8, 2026 · tested runtime `cd1d4af2b0d848d3174f19e26861086d8dd407fc`

The resumed goal made implementation progress and remains **active, incomplete**.
This is local code and synthetic evidence, not publication or a live deployment.
Recorded live fb90a70 / Worker901be347 / schema7 is unchanged and not reverified.

## What now works

An agent can use one private connection to discover/read work, contribute a draft,
accept/start an assignment, report/resolve blockers, submit results and record a
designated exact-version review. Existing operator-authorized credentials can also
propose/supersede work and acquire/release scoped reservations. Four existing tools
plus ten new explicit actions; one descriptor/receipt helper is shared with the
direct client. No second work database, new dependency or changed service semantics.

No enrollment scope was widened. Managed contribution/review presets keep their
existing permissions; steering and outside-write authority are still separate.
No agent tool records a human decision, provisions members, runs a provider, spends
money or performs arbitrary filesystem/network operations. The browser UI is
unchanged and its free/manual/BYO paths remain useful.

Every action preserves caller-owned IDs, exact revision, null-versus-omitted
fields and ordered arrays. A receipt binds room, actor, type, exact data and
operation fingerprint. It confirms the original operation, **not current state**.
An explicit selected-work read determines the current next actor. No automatic
rebase, renewal or mutation retry; transport cancellation never claims rollback.

Known refusals give fixed recovery instructions without echoing server text.
Schema-valid but over-budget input is classified as locally unsent, not a mystery
network save. Claims stay room-local coordination; they do not fence outside code.
Evidence URLs are references, not automatically fetched or verified artifacts.

See [usage](AGENT-WORK-LIFECYCLE.md),
[research and implementation plan](AGENT-WORK-LIFECYCLE-PLAN-2026-09-08.md),
and [workspace roadmap](AGENT-WORKSPACE-ROADMAP-2026-09-08.md).

## Verification

| Gate | Result |
| --- | --- |
| Syntax, core/API and exact cold-package suite | 427 passed |
| Browser regression suite | 121 passed |
| Local workerd/runtime/migration/recovery suite | 10 passed |
| Focused lifecycle/input/transport suite | 19 passed |
| Exact public assets | 16 |
| Production Worker bundle | 225109 bytes, unchanged |

New coverage includes managed contributor/reviewer rework, historical-versus-current
reviews, wrong assignee/chat permissions, unknown producer, changed-input conflicts,
overlapping claims, released/expired-claim retry without renewal, coordinator
propose/supersede without transferring a reservation, and refusal to obtain
write authority through ordinary enrollment. Cancelled saved operations remain
recoverable by exact retry. Sparse direct-client arrays are refused locally.

Read-only independent review found no remaining correctness blocker. It identified
the path-length and oversized-local-input issues fixed before final testing and
the three additional authority/expiry/steering regressions now included.

## Two actual agents, one room

This was not merely a scripted pair of HTTP clients. Two separately tasked agents
used their own private connection and real MCP subprocesses against one disposable
loopback room. Root supplied a shared brief, identities, assignments and timing
barriers; participants authored their commands, blockers, prose and review judgments.
Neither participant was given the other one's artifact text by the coordinator.

Seed ended at sequence7. Sixteen participant events advanced the room to23:

1. A and B read/discovered and accepted their respective assignments.
2. A acquired the fictional shared scope; B received `claim_conflict` with no event.
3. B authored a blocker requesting a handoff. A read it from Room, wrote its own
   welcome, recorded completion and released the scope.
4. B read the handoff, resolved its blocker and deliberately acquired at its new
   revision. A replayed its original acquisition unchanged: duplicate original
   event/sequence10, with A still released and B still holding the scope.
5. B authored three contribution tips, recorded completion and released.
6. Each independently read the other's definition and full summary, recomputed
   its UTF-8 SHA256 and made a pass/fail judgment. Both judged pass.

| Artifact | Producer / bytes | Completion | Independent review |
| --- | --- | --- | --- |
| Welcome sentence | agent-a / 98 | bd62ea92-743f-466b-81b2-4d09df1a07b1, seq14 | agent-b; 82ec8967-403c-4062-b66b-2e7f568cdcf2, seq22 |
| Three contribution tips | agent-b / 302 | 432d59e9-1391-4ef0-b67a-b7c69f38787c, seq20 | agent-a; e3251ed2-f38d-4c8d-b49b-266adb36fefa, seq23 |

Welcome digest:
`382f74801b392ba4ec7c920944e3414a3b1cb5c77da85e12e32f701dc3b0fece`.
Tips digest:
`d31f1450c9de4dcae86e1fa0d887282cc00a52102b1f89db750bc5b9ab729779`.
Root independently recomputed both from the saved event-derived result summaries.

Final revisions A6/B8, both completed, claims released, exact independent pass,
next action `decide` for `owner`, decision null. Owner/A/B read cursors all remain0.
No human-decision events, fetched external evidence, real repository edits or
provider execution occurred. Synthetic `example.invalid` links were not fetched.

Limitations: short synthetic writing tasks, coordinator-staged handoff, existing
operator-provisioned combined permissions, same OS user rather than secret-isolated
runtimes. This does not establish native Claude/Codex/Grok host compatibility,
verified vendor/production identity, independent external originality, unattended
operation, human usability preference or retention lift.

## Screens and evidence

Root inspected desktop, 390px emulated mobile and enlarged-text screenshots.
Quiet work cards retain one explicit decision action; evidence expands in place.
Both cross-reviews and the reachable decision control were inspected in close-up.
Seven final captures have no document overflow, page errors, outside requests or
work/acknowledgement writes. Large text uses a verified doubled root font size,
not a claim of testing native browser zoom.

The first capture attempt failed because its inline style tag was correctly
blocked by CSP. Only the evidence harness was corrected to use the existing
large-text test technique; CSP and application source were not relaxed. Earlier
partial captures were preserved; v2/v3 outputs use new paths.

Local generated evidence (ignored by Git):

- `test-results/work-lifecycle-actual-agents-20260908.json`
  SHA256 `455bbd895b34e0aec09f659ba86fb34402cb9d1a083e84e95feec53be0ed9779`.
- `test-results/work-lifecycle-actual-agents-20260908-v3-browser.json`
  and seven corresponding PNGs, including readable review/decision close-ups.

The verified fixture process exited. Its temporary database, owner/agent keys and
private configurations were removed by its scoped cleanup; directory and process
absence were checked. Generated nonsecret evidence is retained locally.

## Exact package and remaining release gates

Retained outside the checkout, without overwriting earlier packages:
`../project-room-runtime-packages-20260908/candidate-cd1d4af`.

- Source `cd1d4af2b0d848d3174f19e26861086d8dd407fc`.
- Tree `726f286163c04c19e5191d6893881ff4722b31f8`.
- Manifest SHA256 `5671e23ad4a7315fab03fa2e67894f52eb8849095cdd2767d5e810e07457ce8d`.
- 55 exact runtime files,16 assets,schema9.

The new work-actions module is in the literal import closure. Cold tests import
the packaged client/adapter, discover14 tools and build the exact command without
checkout dependencies or a working PATH. Existing package tests also verify
populated schema9 preservation and paused/resumed packaged Node startup.

Historical v8 switch tests and frozen packages remain unchanged, not repurposed
as a v9 fallback. A distinct lifecycle-aware v9-compatible fallback, hosted
recovery/current-authority reconciliation and explicit release approval remain
required. No push, deployment, live migration, account/DNS/provider changes,
outreach, paid compute, payments, personal inbox access or new automation occurred.

## Next useful work

1. Narrow discussion/draft reads and room-native result evidence so agents can
   collaborate beyond the task's original source without importing all history
   or forcing synthetic evidence links. Keep exact provenance/version checks.
2. Apply exact receipts, retained unknown retries and stale-context choices to
   generic human action dialogs; do not silently move a review to newer evidence.
3. Native host acceptance, v9-compatible release recovery and versioned standing
   charters. Then isolated work attempts, scoped delegation and event-driven wakes.
4. Fake-runner-tested Dasha/repository tool contracts before separately authorized
   external execution or paid hosted help.

Continue the active goal after this milestone. Keep the human surface chat/work/
People & agents, with advanced tools and policies disclosed only when useful.
