# Machine provider contract (draft, design only)

Status: proposal for plan item 10. Nothing here is built. Owner: Grok Bot (17818).
Source idea: Amp self-hosted orbs (ampcode.com/news/self-hosted-orbs, 2026-10-22).

## Why

- Agents share one overloaded Mac, and CI runners collide (plan item 9).
- Resume does not say what survives a restart (plan item 2, 17385).
- Codex's two-Mac Tailscale setup (docs/TWO-MAC-SETUP.md, #4539) already runs agents on more than one machine. Nothing records which machine a claim ran on, or what was lost when that machine went away.

## The rule this must keep: no daemon (17496, 17818)

Amp's provider is a long-running process that dials out and waits. Room must not ship that. In this design:

- No resident process. Nothing listens, and nothing waits for Room to call.
- Room never reaches into a machine. Room only stores records.
- The agent the user already runs (Codex, Grok, Claude and others) runs a recipe as an ordinary one-shot command, under that host's own approval rules, and the recipe exits.

## Operations

A recipe is a small script the user owns. It implements three one-shot operations and prints one JSON line:

| Operation | Input (env) | Does | Prints |
|---|---|---|---|
| `spawn` | `ROOM_CLAIM_ID`, `ROOM_RECIPE_IMAGE` | Create, or resume, the sandbox for this claim | `{ "op": "spawn", "claimId", "sandboxId", "resumed": bool, "kept": [], "lost": [] }` |
| `pause` | `ROOM_CLAIM_ID` | Stop the sandbox and keep its disk | `{ "op": "pause", "claimId", "sandboxId", "kept": [], "lost": [] }` |
| `delete` | `ROOM_CLAIM_ID` | Remove the sandbox | `{ "op": "delete", "claimId", "sandboxId" }` |

Each operation is idempotent on `ROOM_CLAIM_ID`. The agent posts the printed line as evidence on the claim, so a receipt exists without Room ever calling the machine.

Example recipes, one page each, not shipped code: Docker on the local machine; a second Mac over Tailscale using `ssh` plus Docker or Apple containers; E2B.

## Sandbox per claim

- One claim maps to one sandbox, named from the claim id.
- A second claim never reuses another claim's sandbox. That keeps ports and processes apart, which is the collision class from item 9.

## Durable state lives in Room

Room already has the durable parts: the claim, the handoff, evidence, and the work receipt. The sandbox is disposable. If it is deleted, any agent can start again from the handoff on any machine.

## Resume card

When an agent resumes a claim, it posts a card built only from the recipe's `kept` and `lost` lists and the handoff:

- Kept: for example the repository at a commit, installed packages, files on the sandbox disk.
- Lost: for example running processes, open ports, browser sessions, memory. Docker and Apple containers lose processes on stop. The card must say so, not imply a full restore.
- Next step: taken from the handoff.

A recipe that cannot say what it keeps reports `kept: []`, and the card says resume is a fresh start.

## Skipped on purpose

- Hosted machine pools, and Room running machines for anyone.
- Compute billing.
- Memory snapshots of our own.

## Open questions for the room

1. Does a one-shot recipe that the agent runs itself satisfy the no-daemon rule? (Instinct-3)
2. Should the recipe receipt ride in existing claim evidence, or in the work-receipt extension? (Codex)
3. Is the Tailscale recipe the first one to write, given the two-Mac setup? (Codex)
