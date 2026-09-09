# Deeper participation without a second product

September 8, 2026. The versioned room-instructions slice is now locally implemented;
see the [checkpoint](ROOM-INSTRUCTIONS-CHECKPOINT-2026-09-08.md). It is not published.
The plan below is preserved as design context; follow-on slices remain future work.
The broader goal remains active and incomplete.

## Product direction

An agent should be a room teammate with a clear purpose, relevant context, a
durable way to notice requests, and explicit access to tools. Its connection
depth should be chosen by its human operator and the room owner, within both
parties' authority. Connecting must not silently enroll it in unattended work.

Keep the ordinary room centered on conversation, work and people. Put advanced
configuration inside the relevant agent or room settings; surface a decision
when it is needed. Manual participation and bring-your-own agents remain useful
without a hosted model or paid automation.

## Research and inference

[Paperclip's agent CLI](https://docs.paperclip.ing/reference/cli/agent/) documents
configuration revisions, separate permission controls, and wake requests carrying
cause and idempotency information. Borrow the separation: changing instructions,
granting access and requesting a run are different operations. This is a reading
of its documented contract, not independent verification of its implementation.

[OpenClaw's standing orders](https://docs.openclaw.ai/automation/standing-orders)
separate continuing operating instructions from the schedules that invoke them.
Its [heartbeat documentation](https://docs.openclaw.ai/gateway/heartbeat) also
distinguishes periodic scheduling, event-driven wakes and execution policy.
Our inference: a Room charter should explain purpose and escalation, while
separate controls decide notification, execution, tools and budget. In Project
Room, charter prose must never grant permission, even if another product calls
such instructions operating authority.

## Implemented slice: versioned room charter

1. Inspect the current owner-authority, event and orientation contracts. Define
   one bounded charter: purpose, expected outputs, boundaries, and stop/escalation
   rules. Establish the exact field limits and empty/unset behavior before code.
2. Add an owner-managed versioned update with expected-revision conflict checks,
   exact-original retry and immutable history. Derive schema/writer changes from
   replay compatibility, even if no new table is necessary. Never reinterpret old
   events or bypass genuine previous-writer migration/refusal tests.
3. Expose the current charter and its revision through existing authenticated
   orientation. Preserve selected-work context boundaries; do not export every
   room conversation or private participant notes. No agent edit tool initially.
4. Add a compact optional section to room settings, with explicit Save, honest
   unknown-save recovery and a readable revision indicator. Existing rooms and
   quick-start flows work without a charter. An empty charter adds no dashboard.
5. Test owner versus ordinary-member access, revoked sessions, stale updates,
   exact retries, historical replay, output limits and absent-charter behavior.
   Run service, browser, Workers and package/recovery gates as appropriate.
6. Have actual producer/reviewer participants read a synthetic charter and carry
   out a task with its constraints. Verify that charter text alone cannot confer
   authority to claim, approve, spend or use an external tool. Keep human approval
   pending unless a human deliberately acts. Capture desktop/mobile/large-text UI.

## Follow-on slices, separately gated

- **Durable attention:** pull-first unread reasons tied to a cause, charter/work
  revision and deduplication key. Seen, delivered, accepted and completed are
  distinct states. Do not change human read markers or launch a model to poll.
- **Eligible work:** read-only suggestions based on explicit capabilities and
  current authority. Existing acceptance, assignment and collision controls still
  apply. A suggestion is neither an assignment nor permission to execute.
- **Standing agent roles:** opt-in responsibilities with bounded scopes and a
  clear pause/revoke path. Changes do not silently revive old recurring work.
- **Tools and Dasha compute:** isolated attempts with explicit workspace, tool
  scope, budget, cancellation and result provenance. Separate model access from
  action permission and room membership. Start with a fake runner contract;
  real providers and spending require fresh authority.
- **Native-host acceptance:** verify real Claude, Grok and other supported hosts
  one at a time using their documented connection mechanisms. Instinct remains
  unverified until its actual product interface is established. Manual prompts
  and explicit result returns remain a fallback, not a claimed live integration.
- **Release qualification:** build a v11-compatible fallback and exercise hosted
  restore/current-authority reconciliation before proposing publication. The old
  v8 app-switch proof is historical, not safe fallback proof for schema 11.

Success is an agent understanding its role, seeing the right work and returning
a reviewable result with less ceremony—not more ambient autonomy or more menus.
