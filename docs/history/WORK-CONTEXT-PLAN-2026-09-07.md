# Selected-task context: research and implementation plan

## Problem and decision

The current agent guide fetches orient() and snapshot(), then finds the work and
joins its source message manually. Each call downloads the room-wide snapshot.
The portable packet is deliberately narrower and cannot substitute for an
authenticated current-task view: it excludes claim/evidence/review details and
must remain safe for an explicit proposal-only export.

Build one selected-task read, not another runner or product surface. It serves
both an authenticated HTTP client and a simple JSON CLI. Reduce transport and
model-visible unrelated context together; do not stop at filtering a full
snapshot on the client. No browser UI or portable packet change in this slice.

Primary sources checked 2026-09-07:

- [Anthropic tool design](https://www.anthropic.com/engineering/writing-tools-for-agents)
  recommends focused, coherent context tools instead of returning every record,
  followed by realistic agent evaluation. Borrow consolidation and relevant
  context, not a large overlapping catalogue. No performance claim transfers here.
- [Linear agent interaction](https://linear.app/developers/agent-interaction)
  distinguishes structured task/session context and formatted prompt context.
  [Its setup guidance](https://linear.app/developers/agents) distinguishes human
  assignment and agent delegation. Borrow explicit current responsibility, not
  mention-triggered execution. The APIs are documented as a developer preview.
- [GitHub task guidance](https://docs.github.com/en/copilot/tutorials/cloud-agent/get-the-best-results)
  emphasizes bounded work, acceptance criteria and relevant guidance. Borrow
  coherent deliberate review feedback, not automatic execution from every comment.
- [MCP schema](https://modelcontextprotocol.io/specification/2025-11-25/schema)
  supports structured outputs; read-only annotations are hints, not authority.
  A future wrapper can reuse this contract. No MCP compatibility is claimed now.

These documented patterns and current code support the design inference. They do
not establish retention, model quality, latency or population-level token savings.
No third-party code is copied or new dependency introduced.

## Public contract

- GET /api/rooms/:roomId/work-context?workItemId=ID, optional includeSource=true.
  Unknown/duplicate query fields and non-boolean source choices are rejected.
  Existing supported browser auth selection remains available; a requested viewer
  never overrides authenticated identity. Existing read limits/cache/auth apply.
- RoomAgentClient.workContext(id, { includeSource: false, signal }) makes one GET.
  Validate the ID/options locally, validate returned room/task identity, forward
  read cancellation, reject redirects and never fetch an evidence URL. No fallback
  to full-room data or automatic retries.
- agent-inbox work WORK_ID [--include-source] returns structured JSON. Invalid or
  surplus arguments fail before network access. Help describes work versus
  packet: authenticated current context is not a portable public export.

Inside one store read transaction, authenticate, read one committed room projection
and capture the service clock once. Return a versioned envelope with room/viewer
ownership, evaluatedThrough and evaluatedAt. Return exactly one allowlisted work
record: ID/title/outcome/revision/state/mode; assigned role IDs; current claim,
blocker, receipt, verification, decision; replacement and source references.
Do not include receipt/decision histories, full member directory, event log,
personal reminders, cursor, credentials or unrelated work/messages.

Include the viewer's current kind/revision/permissions, selected participants'
IDs/names/kinds/active status, nextWorkStep(work, now), whether the next actor is
the viewer, and shared workActions as *suggested Room actions*. These are hints,
not a canAct guarantee: global scope conflicts and every command remain checked
by the service. Completion never supplies human approval; claim records never
prove external execution permission or that another process stopped.

Source inclusion is explicit and only by work.sourceMessageId. Its status is one
of not_requested, not_linked, unavailable or included. No nearest-message guess,
thread expansion, linked content fetch or source-body interpolation as trusted
instructions. Current evidence URLs stay references in this authenticated view;
the portable packet's strict v1 export allowlist remains unchanged. Room membership
still grants room-wide access: response minimization is not task-private authority.

## Implementation ownership

Root owns product/client/CLI/docs and integration. Three reviewers are read-only.
Use existing event validation, nextWorkStep/workActions, shared HTTP handler and
RoomStore transaction adapter. No new persistence or schema. Keep Node and local
Cloudflare behavior aligned. Do not add an action dispatcher or auto-generated
write commands. Retain caller-owned revision/ID semantics in the existing guide.

## Verification

1. Pure projection tests: exact selected work and source, omissions, participants,
   current revision/receipt/gates, viewer without permissions, distinct reviewer
   and human decision roles, blocked/replaced/completed states and exact expiry.
2. Store/HTTP tests: one committed projection/clock, auth/binding/room boundaries,
   invalid/unknown/punctuation IDs, explicit source options, no-store behavior,
   no GET mutations to events/cursor/claims/reminders, consistent restart and
   unchanged unrelated writes versus rejected stale selected-task writes.
3. Client/CLI: one GET, cancellation, identity mismatch rejection, no evidence
   fetch, secret-safe diagnostics, strict args and executable guide examples.
4. Fresh actual agents: a blocked fictional documentation task with prior failed
   review, released scope and distractor context. Producer receives only its own
   fixture configuration, task ID, permitted guides and explicit local authority.
   It reads the selected view, prepares an original correction and records actual
   evidence. Fresh reviewer checks it independently and records its real finding.
   Do not prescribe a pass. Human decision remains null; no external execution.
5. Record deterministic request counts and serialized response sizes against
   orient()+snapshot() in the same fixture. Do not infer general token, speed,
   cross-vendor, human preference or retention improvements from this exercise.
6. Full core/browser/local Cloudflare suites, exact asset packaging and production
   bundle. No new UI means existing first-use/mobile/large-text screenshots are
   regression evidence, not a new design claim. Document final results and limits.

Checkpoint locally, update handoff/board/bus and keep the full goal active. No
push/deploy/live migration/provider/DNS/payments/outreach/paid compute/scheduled
automation. Recorded live remains v7; earlier local reminders require a separate
v8-compatible release/fallback/recovery package.
