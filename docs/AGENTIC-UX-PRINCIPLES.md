# Agentic UX Principles — Project Room Design Policy

Durable design policy for Project Room, distilled from published multi-agent
systems research and postmortems (agentic-interface design writing, oversight
research, agent-identity standards work, and multi-agent orchestration
practice). Every new surface — human or agent-facing — should be checked
against these principles before it ships.

## 1. Cockpit, not dashboard

A dashboard you look at; a cockpit you operate. Project Room's human surfaces
must be instruments and controls, not passive reports:

- **Pages become timelines.** Work in motion is shown as a readable timeline of
  what happened, what is happening, and what is about to happen.
- **Fields become scopes.** Show what an agent is allowed to touch, not just
  form fields.
- **Buttons become permissions.** Membership actions are explicit grants —
  who authorized what, when.
- **Logs become evidence.** Every consequential action leaves a retrievable
  record: who did it, what changed, why, and under whose authority.

## 2. Oversight is structural, not observational

Monitoring tells you what happened. Oversight gives you the capacity to shape
what happens next. A status page with green lights is not oversight.

Concretely: pause, veto, rollback, and escalation must be **first-class
actions**, not edge cases. If the only way to intervene is to wait for
failure, the loop is broken. Human-on-the-loop is a dynamic framework —
intervention thresholds are contextual and risk-based, not static rules.

## 3. Proofs over prose

Never ask a human to approve a paragraph. Approvals reference artifacts:
diffs, previews, change sets, impact summaries. Verification must be easier
than blind trust.

The same applies to agent identity: a directory card that only carries
self-published marketing copy (name, description, capabilities) is prose.
Trust comes from attached evidence — who approved this agent, when, with
what authority envelope, which key fingerprint, and whether it is currently
active, paused, or revoked. See `docs/AGENT-IDENTITIES.md`.

## 4. First sixty seconds

An agent should go from zero to productive in one fetch. The room activation
pack (`GET /api/rooms/:slug/activation-pack`) is the machine equivalent of a
first-run screen: room state, members, open work with claimants, rules, and
suggested first work — everything needed to start, nothing to go hunting for.

The human side follows the same rule: one prompt pastes an agent into the
room (`docs/join/team.md`); one screen, one action between intent and the
first productive step. No upfront grids, no surveys, no empty states staring
back. Contextual guidance appears at the moment of use.

## 5. Identity is approved; authority is granted

Agents are first-class members but do not inherit owner powers:

- A human approves each agent's public identity (name, bio, avatar). The
  human never hands credentials to the agent.
- Each runtime gets its own credential, shown once and never recoverable.
  Credentials are scoped to least privilege.
- Authority (membership administration, financial powers, secret access) is
  a separate, owner-granted capability — never self-grantable, never
  transitive, always revocable.
- Revocation and pause are visible states on the agent's record, not silent
  deletions. Anyone reading the directory can see whether an agent is
  active, paused, or revoked.

## 6. Coordination is protocol, not vibes

Parallel agents collide on shared files and duplicate work unless the
protocol prevents it:

- Announce intent before touching shared resources.
- Claims name the exact files they will touch; overlapping file claims
  across open claims are flagged before work starts
  (`server/claim-collisions.mjs`).
- One task claimed per agent per work cycle; claims expire after inactivity.
- The host never assigns overlapping edits to different workers at the same
  time; workers defer to ownership decisions when conflicts arise.
- A maintainer-style summary (who is active, on what, recent decisions,
  next steps) keeps the room legible without constant polling.

## 7. Friction scales with blast radius

Do not confirm every turn; intervene when a collision is likely. Approvals
and review gates are reserved for high-impact steps:

- Low-impact work: self-attested.
- Shared or visible work: reviewed by a distinct member.
- High-impact work (merges, deploys, membership changes, money): independent
  review or owner approval.

Work items carry their delivery mode (`result` / `merged` / `production`)
and review policy explicitly, so the required friction is visible up front
instead of discovered at the gate.

## 8. Reversibility by default

Execution should default to undoable: dry runs before live runs, expiry on
claims and locks, pause before revoke, and safe handover when an agent
stops. Destructive actions (key revocation, membership removal, production
deploys) are explicit, logged, and attributable.

---

### Checklist for new surfaces

Before shipping a human- or agent-facing surface, confirm:

1. Can a new agent become productive from this surface in one fetch/prompt?
2. Does it show authority (who can do what) — not just activity?
3. Can a human pause/veto/roll back from here, mid-execution?
4. Does it present artifacts for approval, not prose?
5. Does trust evidence (approver, grants, key, status) appear where identity
   appears?
6. Is every consequential action attributable and retrievable afterward?
