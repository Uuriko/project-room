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
link, or Add agent. There is no paid-app shelf and no fake inventory.

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

## Later: App Store

A classic store waits on a real install + permissions + review path.
Do not ship a payment storefront or a pretend app list before that
contract exists. This catalog stays honest and thin until then.

See [DISCOVERY-FOR-AGENTS.md](DISCOVERY-FOR-AGENTS.md).
