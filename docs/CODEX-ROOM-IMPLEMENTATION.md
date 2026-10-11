# Codex-shaped Room implementation

## Goal and boundary

Make existing Room work easier to follow, interrupt, resume and verify without
creating another board, identity system or completion authority. A visual
prototype is design evidence, not a working runtime integration.

The source audit inspected Codex main at
[`cc7ba33601286a751477832b01de7b6f8de0dd9c`](https://github.com/openai/codex/tree/cc7ba33601286a751477832b01de7b6f8de0dd9c).
Main-only and experimental interfaces must be checked against the chosen
runtime release; the audit does not establish their availability in 0.162.1.
Use the existing SessionAdapter/native-host boundaries. Never weaken host
isolation, forward ambient credentials, enable model access or invent control
identity to make an integration test pass.

## Phase 1: establish honest completion evidence

1. **Offline completion inspector.** Merged in [PR #2551](https://github.com/Uuriko/project-room/pull/2551).
   `scripts/codex-evidence-summary.mjs` inspects an explicitly supplied capture
   without launching anything. This change wires its pure summarizer into
   `scripts/native-host-request-run.mjs` after the original evidence is saved.
   Owner: Jill - Dot. Acceptance: Codex requires accepted, complete
   evidence, process exit zero and a completed terminal turn. Incomplete,
   failed, malformed and unsupported streams fail even with process exit zero.
   Failed tools remain visible and do not independently invalidate a completed
   turn: turn completion does not establish correct work or Room acceptance.

The manual runner's final JSON adds `codexEvidence` for resolved Codex runs.
Existing process fields and the private evidence format remain unchanged.
A separate pre-existing progress-log leak is also repaired here: only locally
allowlisted event/tool/status labels are printed; malformed object values and
unknown tool names stay in the private capture, including Claude tool-use names.
Claude keeps its existing process-exit contract; its terminal evidence is not
validated by the Codex inspector. An unresolved executable still records the
existing failure evidence and starts nothing.

The current slice changes exactly these files:
- `scripts/native-host-request-run.mjs`: save raw evidence first, summarize,
  then select the exit status
- `tests/native-host-run-guards.test.js`: invoke the real runner with a local
  synthetic executable, with no installed agent, identity or network access
- `docs/CODEX-ROOM-IMPLEMENTATION.md`: implementation sequence and boundaries

The integration guards cover missing/failed/malformed terminal evidence, fatal
stream errors, the wrong dialect, nonzero and signaled exits, CRLF with a final
line without a newline, retained raw capture, redacted summary, failed tools
and unchanged Claude behavior. Existing inspector tests own detailed parser
coverage; this suite owns whether the runner actually uses that verdict.

## Phase 2: show existing work clearly

2. **Pending contributions near the composer, with identity.** Planned; Grok
   Bot and Jill - Dot have agreed to pair on UI, with individual file claims still
   required. Reuse existing assistant input/revision records. Acceptance:
   show the author and unapplied contribution without implying the running
   model has read it; a later revision cannot erase an earlier pending input.
3. **Compact truthful activity, live-follow and read anchor.** Planned in the
   same proposed UI lane, after the evidence semantics are agreed. Reuse the
   existing event stream and visibility checks. Acceptance: distinguish
   reported activity, transport health and observed completion; preserve the
   reader's position while updates arrive and across reconnect.

Neither UI opportunity requires a new runtime, auto-scroll takeover, private
reasoning display or duplicate event store.

## Phase 3: integrate a typed runtime and prove the boundary

4. **Pinned app-server adapter.** Planned; proposed owner: Jill - Dot.
   Begin with initialization, read and resume through the existing adapter
   seam, backed by strict runtime validation and capability checks. The
   current HerdrBridgeAdapter is unmounted; extending its types alone is not
   a live integration. Pin binary and protocol together. Acceptance: reject
   unsupported required methods, preserve partial-history labels, reattach
   before replacing a runtime, and scope items by backend/thread/turn/item.
5. **Exact turn/attempt controls and recovery.** Existing separate Codex work:
   [PR #2510](https://github.com/Uuriko/project-room/pull/2510) and the R36-2
   recovery workstream; check their actual landing state before extending.
   Acceptance: stale Stop cannot target a newer attempt; requested Stop stays
   pending until matching terminal evidence; reconnect does not execute twice.
   Native `codex exec --json` provides no native turn ID. A local ordinal must
   never be substituted for app-server turn identity or used as control proof.
6. **Explicit typed approvals.** Planned integration with Jill's approval
   ownership and R36-1 persistence. Bind each decision to the exact action,
   target and version; resolve or expire pending decisions coherently after
   interruption. Session-wide grants need an explicit owner policy, not an
   inference from one approval. Acceptance: stale decisions cannot authorize
   revised actions, and reconnect cannot turn a pending request into consent.
8. **Failure harness and conformance.** Planned alongside opportunity 4;
   proposed owner: Jill - Dot, with independent review. Start with
   synthetic protocol fixtures, then a separately reviewed credential-free
   mock-provider harness. Reject unknown service methods; assert exact request
   counts and normalized model-visible context. Cover duplicate/late events,
   interrupted approvals, partial history and reconnect during a command.

Do not advertise a full app-server adapter, native control support or live
model qualification until those owning-boundary tests and deployment checks
have actually run. The current runner change supplies none of those claims.

## Phase 4: repository evidence and optional extensions

7. **Exact repository evidence.** Planned extension of existing host-result
   evidence, coordinated by Jill - Dot with the UI owner. Bind diffs to
   repository, base and head; retain exact patch bytes. Report CI, review,
   merge and deployment separately. Acceptance: changing a linked PR head
   cannot silently change the revision a result says was inspected.
9. **Runtime references on existing attempts/handoffs.** Optional, after 4/5
   define trustworthy identity and recovery. Link runtime references to the
   existing record; references grant no authority and do not replace Room IDs.
10. **Guarded worktrees.** Optional, after repository identity and ownership
    are proven. Require one owner and explicit cleanup scope. Never reset a
    dirty worktree or delete unrelated work to recover an execution.
11. **Non-secret effective role/configuration snapshot.** Optional, after 4/6
    define the boundary. Record the relevant effective configuration with
    secret redaction; a snapshot cannot grant or enlarge permissions.
12. **No duplicate systems.** Architectural constraint across every phase,
    not another feature: reuse Room's board, identities, event cursors,
    attempt ownership, authorization and receipt/completion rules.

Opportunities 9–11 have no implementation owner or active implementation in
this slice. Evaluate them only when their prerequisite integrations expose a
concrete user need.

## Rollback and continuity

The runner gate has no database migration or saved-configuration change.
Reverting its import/summary/exit predicate restores the previous process-only
behavior, including its weaker completion guarantee; keep existing private
captures and the standalone inspector. Never overwrite a capture or rerun an
ambiguous attempt merely because inspection failed. Inspect the saved capture
and reconcile original Room operations before deciding whether another run is
appropriate. Preserve existing native resume, occupant fencing, Stop owners,
request journals and receipt authority throughout later phases.

For this slice, use the focused runner, binary-resolution, inspector and
host-result suites, then inspect `verify:affected --list` and run applicable
checks plus lint. Synthetic success is not live-host or deployment clearance.
Before continuing, refresh main and live claims, verify the previous slice's
exact-head CI/landing evidence, and claim the next integrated path with its
owner. No phase authorizes production changes or new credential access by
itself.
