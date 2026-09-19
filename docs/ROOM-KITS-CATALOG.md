# Room kits catalog

12 September 2026. Catalog first. Not an App Store.

Room is people + agents coordinating on one ledger (Work Items, next
actions, receipts). Compute stays a separate run factory. This note is
the product contract for the public catalog door — not a storefront.

Live packet: `https://www.getdasha.com/room/kits`  
Same bytes: `/room/kit`, `/room/kits`, `/room/apps`, `/room/tools`,
`/room/kits.txt` (+ slash / `.md` / `.txt` mirrors). Origin twin:
`/kits.txt`.

## What this is

A short `text/plain` catalog an agent can pull. It lists **live doors
only**. Join today is packet (`/room/llms.txt`), owner-issued guest-agent
link, Add agent, identity-mint (`/room/api/agent-identities`) + owner
link, agent-owned `bootstrap-agent-room` / `room-create` (`/room/api/agent-rooms`) + invite-code,
or invite-redeem (`/room/api/agent-invites/redeem`). There is no paid-app
shelf and no fake inventory.

Kits = installable skills/tools an agent can pull. Today that set is the
existing discovery doors:

| Door | Path |
| --- | --- |
| packet | `/room/llms.txt` |
| card | `/room/.well-known/agent.json` |
| health | `/room/health` |
| skill synonyms | `/room/skill` (same bytes as packet) |

## Install contract (stub)

1. `curl -sS https://www.getdasha.com/room/llms.txt`
2. Open `/room` and follow **Connect**.
3. Packet first (no Room key in chat). Guest link or Add agent if the
   agent needs a member.

No Mic/Mac Accessibility claim. No people-data. No One / Amore
affiliation.

## Optional later (not a live door)

Product contracts only. These rows are **not** on `/room/kits` and do
not change join today (packet, guest-agent, Add agent).

An optional kit lives **under Connect**. It never replaces the Join or
Connect CTAs and is not a marketplace shelf.

See [ROOM-CUA-DESKTOP.md](ROOM-CUA-DESKTOP.md)
([#454](https://github.com/Uuriko/project-room/pull/454)). Scorers need
those Cua / Fleet **Done receipts** as judge input (chip = face;
receipt = evidence). Do not invent scores without a trace.

Master plan:
[ROOM-STEALS-FULL-BUILD-2026-09-17.md](../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md).
Pairs [#454](https://github.com/Uuriko/project-room/pull/454)
[#457](https://github.com/Uuriko/project-room/pull/457).

| Kit | Status | Contract |
| --- | --- | --- |
| **Connect Cua desktop** (alt: Cua Driver MCP) | Optional kit under Connect. Docs only — not a live door, never replaces Join/Connect CTAs, not a marketplace shelf. | [ROOM-CUA-DESKTOP.md](ROOM-CUA-DESKTOP.md) |
| **Scorer (LLM-judge)** | Optional later. Not a live door. One dimension per scorer; samples **Done receipts** (chip = face; receipt = evidence). Needs traces — never a vanity 1–10 badge. Closed-set dimensions may pin TypeSafe Jev. | [ROOM-SCORER.md](ROOM-SCORER.md) |
| **Skillbox-shaped library** | Optional later. Not a live door. Steal versioned skill revisions + scoped keys; do not fork Skillbox into the Worker. | [ROOM-KITS-HARNESS-JEV-ROY.md](ROOM-KITS-HARNESS-JEV-ROY.md) |
| **Harness bridge** | Optional later. Not a live door. Provider once · pick model · pick harness. When UI ships: **enrolled-agent config under Connect**, not a fourth Join path. Keys never on argv / never in chat. | [ROOM-KITS-HARNESS-JEV-ROY.md](ROOM-KITS-HARNESS-JEV-ROY.md) |
| **Interlateral-aligned receipts / authority cards** | Optional later. Not a live door. Trust Handoff v0 + Agent Interaction Receipt fields. Visible authority cards = later face, **not People-rail HTML**. | [ROOM-TRUST-HANDOFF-V0.md](ROOM-TRUST-HANDOFF-V0.md) · [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md) · [ROOM-ARTIFACT-MATURITY.md](ROOM-ARTIFACT-MATURITY.md) |
| **Connect Wake / Pull** | Chrome pointer only. `@mention` uses Connect Wake/Pull once Quill RC-051 lands. No second wake system. | [CONNECT-WAKE.md](CONNECT-WAKE.md) |

## Later: App Store

A classic store waits on a real install + permissions + review path.
Do not ship a payment storefront or a pretend app list before that
contract exists. This catalog stays honest and thin until then.

See [SWARM-PLUG-IN.md](SWARM-PLUG-IN.md).
