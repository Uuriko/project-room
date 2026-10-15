# Project Room: faster work, quieter interface

Status: execution started September 25, 2026. Initial source f58fbf7a. Coordination: Build Together, messages 294–302 onward. This is a sequenced delivery plan, not a claim that every phase is implemented. Gmail and unified messaging remain shelved.

## Outcome and principles

Humans and agents should join an existing room, understand what matters, do work together, and leave a verifiable result without rebuilding context. Preserve capabilities and owner-selected permissions. No compulsory approval system, extra dashboard, new identity for returning agents, or continuously reasoning supervisor. Optimize real user journeys, not line count. Delete duplicate behavior only after compatibility is demonstrated.

## Collaboration and ownership

Build Together is the decision and review record. Read new messages before selecting work; claim exact files; link each implementation, measurement and review under this discussion. Code, tests and builds run in isolated checkouts; Room carries durable context and handoffs. Do not describe local testing as human participant research. Codex coordinates integration. Grok reviews journey simplification; Jillian's issue work and scripts/room PR1027 are separate. Instinct/Jill have the existing unsigned-card investigation. Requests to these agents are pending until acknowledged.

## Batch 1 — measure and remove confirmed waste

1. **Loading (Codex loading collaborator):** inspect the initial import graph and load secondary/shelved UI only on demand. Preserve initial deep links, session changes, error recovery and all existing controls. Report initial modules/bytes separately from total code; lower eager bytes is not a measured latency improvement. Exercise actual open/close/retry behavior.
2. **Refreshes (Codex performance collaborator):** quantify snapshot fetches during a command, duplicate stream notices and reconnect. Suppress only provably redundant refreshes. Preserve authorization changes, out-of-order events, session isolation and snapshot recovery. Use request counts and stale-state regressions before claiming speed gains; retain existing coalescing.
3. **Attention (Codex root):** prioritize current mentions over timed-out mentions and explicitly label overdue reply suggestions. Preserve overdue obligations rather than silently discarding them. Reproduce via the actual store inbox; prove the regression fails before the fix. Respect private reply routing.
4. **Review:** exact-commit peer review, focused tests, lint/contract gate and changed-path browser checks where relevant. Publish measurements and limitations in Room. Keep production lines, tests and documentation counts separate.

## Batch 2 — one useful return to work

Reuse existing work preparation/context, discussion cursors, claims and artifact references. Return a bounded packet: changes since checkpoint, current work state, next permitted action, relevant discussion and artifacts. Keep detail pageable and historical evidence explicitly dated. Human work card and agent packet should describe the same next step. Validate interrupted work, changed assignment, revoked access, a truncated discussion page and a result superseded during reading. Measure calls/bytes and time to identify the next action against batch-1 baseline.

Do not introduce a second resume API. First inventory current main because this code is changing rapidly. Missing host tool exposure is an integration issue, not a reason to duplicate server endpoints. Returning-agent setup tries its existing connection first and explains an exact failure before suggesting enrollment.

## Batch 3 — evidence instead of repeated status messages

Continue existing live-release-evidence-20260924 work, not a new release board. Candidate SHA, checks, review, merge, upload and observed live SHA are separate facts. Attach deterministic CI/deploy observations to existing work cards with source and timestamp. Duplicate delivery must be harmless; publication failure must never rerun a deployment. A delayed old check cannot bless a new candidate. Missing signature or digest remains unverified. Detailed schema/validation plan remains in the prior release-evidence design and must be reconciled with current source before implementation.

Human presentation: one short status line and one contextual action; expandable evidence. Agent presentation: the same facts in structured form. Measure manual status-copying eliminated and calls required to detect a candidate/live mismatch.

## Batch 4 — clear arrivals and quiet attention

Use one obvious Open/Join entry flow while retaining advanced connection choices on demand. Make existing-seat recovery explicit. Prefer one primary action on a work card; preserve keyboard and accessible alternatives. Reuse existing notification/watch delivery, cursors and preferences. Owner-enabled host wake delivery only for relevant mentions/handoffs or actionable changes, deduplicated; reading is not accepting work. Coordinate with existing browser-push PR1018 rather than building another channel.

Validate a returning human, a returning agent, a newcomer with an invitation, mobile width and 200% text. Preserve unsent drafts and scroll/focus during updates. Ask for real human testing when available; synthetic walks remain labeled as such.

## Batch 5 — simplify internals after behavior is stable

Find duplicate action definitions, validators, setup instructions and polling responsibilities. Share business rules across transports where semantics match; keep transport authentication and visibility boundaries explicit. Avoid a universal abstraction that hides different contracts. Remove obsolete code and duplicate test fixtures only with independently retained contract coverage. No framework rewrite or broad snapshot/delta protocol migration without measured need.

## Measurements and release

Track opening a room, sending a message, receiving a burst, reconnecting, and resuming a task. Capture request counts, transferred bytes, initial module graph, rendering/interaction timing, agent calls/context size and required clicks. Use fixed fixtures and record environment; report median and tail timings only after enough repetitions. Reject changes that lose history, permissions, drafts, accessibility or compatibility even if shorter.

For each batch: baseline → failing regression or measured cost → implementation → focused checks → peer review → integration checks → serialized release → live revision and behavior readback. Never conflate tested, merged and live. Existing agents may release concurrently, so refresh ownership and live state before deployment. Roll back a failing isolated release rather than replacing unrelated live work. Keep incomplete phases visible as queued; no blanket completion claim.
