# Agent-first work, with a small human view

Comparison checkpoint: November 16, 2026 UTC. Room baseline is the deployed
`8f1caea3cecacb1e756911dc3800a253e36bbcf3`. This is a primary-document/source
comparison plus a real Room contribution trial, not a timed cross-product test.
Competitor features below are documented behavior, not independently qualified
on this Mac. Missing evidence is not evidence that a competitor lacks a feature.

## Decision

Design the agent contract first: an authorized assignment, bounded relevant
context, a current next action, a saved result, correction, exact review and
acceptance. Agents use MCP, HTTP or stdio directly. A browser must not be a
prerequisite for picking up or returning work. Human views should expose the
outcome, current result, blockers and decisions from those same records.

Room already has that storage and authorization foundation. A wholesale UI or
backend rewrite is not justified by this comparison. The worthwhile overhaul is
to make one supported machine path the default and keep the human surface small.
Do not replace SQLite, introduce another queue or rebuild a fleet dashboard.

## What the references teach us

| Reference | Concrete mechanism | What Room should use | Boundary |
| --- | --- | --- | --- |
| Linear | API/webhook agent sessions, typed activities and relevant `promptContext`; distinct agent identity | Clear invocation, contextual handoff and honest lifecycle; compact human progress | Its UI-native interaction guidance does not require agents to operate a browser |
| Block Buzz | JSON CLI and MCP tools; saved logical session associations before execution | Discoverable machine commands, exact operation inputs, explicit source/session scope | Its desktop/relay/plugin architecture is much broader than this one-room goal |
| Beads | `ready`, atomic claim, structured task inspection and durable dependency state | A short pickup loop and one source of current task truth | Its Dolt graph/storage/sync system is not needed to retain Room's task semantics |
| GitHub Copilot cloud agent | Assigned issue/context becomes repository work and a reviewable PR | Make accepted output the product, with source/check evidence and a correction path | Coding-specific managed execution is not a substitute for arbitrary existing hosts |

Linear's activity history is documented as the reconstruction source because
ordinary comments can be edited. Room should retain exact result/version evidence
and distinguish requested, received, started and accepted. Linear's session plan
API is technology preview; a useful example, not a dependency or settled contract.
[Agent interaction](https://linear.app/developers/agent-interaction),
[best practices](https://linear.app/developers/agent-best-practices),
[interaction guidelines](https://linear.app/developers/aig).

Buzz explicitly makes the CLI an agent-facing surface with JSON output, structured
errors and distinct conflict/auth/network exits. Its local association design
keeps logical session identity over reconnects and rejects retired-lifetime
requests. These are useful invariants, not a reason to import its entire runtime.
The newer app also offers a local tool helper to agents it did not start; that
is worth studying for a future supported existing-host connection, with its user
and sandbox limits intact. Its remote-agent document is explicitly a draft.
[CLI](https://github.com/block/buzz/blob/75d78eab68416d9144e1075f84c061d4f406cde8/crates/buzz-cli/README.md),
[agent/session contract](https://github.com/block/buzz-app/blob/3fca4520a53dc5618c908361e332b84ff45dba6a/docs/agents.md),
[remote draft](https://github.com/block/buzz/blob/75d78eab68416d9144e1075f84c061d4f406cde8/docs/remote-agents.md).

Beads makes ready work and taking responsibility first-class machine operations.
Its documentation also records HTTP divergences and unknown-write outcomes rather
than pretending every backend has identical guarantees. Reuse that discipline:
cache context, never authority; retain immutable input for ambiguous retries.
[Beads source](https://github.com/gastownhall/beads/tree/8cdfa796a8f571266f2687f8b80365cbe26a943d).
GitHub supplies initial issue context to its cloud agent, then uses the PR for
follow-up work; later issue comments are not automatically included. Room should
make the current discussion/result boundary equally explicit.
[GitHub task flow](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/kick-off-a-task).

## Room's measured friction and changes

The real signed-in Claude Code runtime received one bounded read-only task in
the existing room, submitted evidence, received an independent Codex correction,
submitted a corrected result, and obtained delegated owner acceptance. This
proves that path actually ran. Acceptance was performed under the owner's
standing delegation; it is not a claim that the owner personally reviewed it.

The trial retained failures: a bespoke shell helper added an unsupported pickup
argument, a host allowlist blocked a later shell attempt, an initial brief omitted
source text by design, and a first report exceeded the native text-evidence limit.
The native MCP path then completed without a browser. Independent review rejected
an overstated routing concern before accepting corrected findings. These failures
are reasons to use discovered tools/schemas directly and state result limits early.
No before/after task-time baseline exists; no agent speed or quality win is claimed.

Changes based on that evidence:

- Repeat `room_read_work` brief reads accept a retained `knownBriefVersion`.
  They recompute authorized current context and continuation. If the scoped brief
  is identical, they omit repeated text; otherwise they return the full brief.
  Exact result/discussion preparation cannot use the shortcut. Omitted content is
  not certified unchanged. No authority or stale result is cached.
- One `nextWorkStep` value feeds the card's status and action presentation. Existing
  action eligibility still comes from current `workActions`; no permission is added.
  Legacy handoffs can use the current room owner fallback; current handoffs retain
  their explicit triage member.
- The human card shows a bounded finish condition and current result summary next
  to the next action. Full evidence and version details stay available. The task
  form prompts for output, allowed scope, checks, producer and reviewer.
- The existing source-observation and discussion checkpoints remain the way to
  avoid resending unrelated history. Do not create a second context store.

## Open-source reuse

`client/operation-metrics.mjs` adapts Buzz's actual percentile calculation, bounded
sample buffer and numeric request-summary approach. It records fixed operation
labels, durations, response sizes and failures; no text, identifiers, URLs or
credentials. It defaults off and creates no timers, observers, network or storage.
It is used for local qualification, not as a new product dashboard. See
`third_party/buzz-metrics/NOTICE`, its Apache-2.0 license and `THIRD_PARTY.md`.

Retain Room's existing Buzz-derived signal-log code rather than import it again.
Session admission/tool-operation modules were inspected but not imported: their
native client, plugin and authority bindings are coupled to Buzz. Useful invariants
are recorded above; copying them unadapted would not preserve Room's security.
The earlier pinned Buzz client research remains valid evidence, not an active
instruction to revive matching, search or peripheral feature expansion.

## Acceptance for the next slices

Consistent useful results are primary, with time and context savings supporting
that goal. [The core workflow](CORE-WORKFLOW.md#quality-and-consistency) owns
proportional review, correction and evaluation of rework/reopened work/later
regressions. Native connection instructions use the default complete-work catalog;
the full catalog remains optional.


One real contribution must complete without a custom per-task shell helper or
browser. Measure onboarding corrections, failed calls, useful accepted output,
review corrections and requester interventions separately. Report failure latency
as well as success. Compare matched tasks before claiming faster execution.

Keep the task's output, scope and check criteria explicit before starting; missing
scope is a blocker to resolve, not permission to guess. Use default core tools,
selected reads and retained brief versions. A context fingerprint is not a grant,
a wake is not execution, and a result is not independent acceptance.
