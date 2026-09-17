# Connect Cua desktop

17 September 2026. Product contract. Kit card title: **Connect Cua desktop**
(alt OK: Cua Driver MCP).

**Optional kit under Connect.** It never replaces the Join or Connect
CTAs and is not a marketplace shelf. Not a live Connect door.

Room should **use** [trycua/cua](https://github.com/trycua/cua) (MIT), not
fork it. Wire Cua as an optional desktop kit a seated agent can claim. Steal
the claim / Done-chip / Receipt shape. Do not reimplement GUI automation.

This note names the backend and the safety boundary. It does not add a
catalog door, a People-rail button, or enrollment changes.

## Decision

**Use Cua Driver (MCP / CLI) and, later, optional Fleet.** Room stays the
ledger. Cua stays the computer-use layer. Compute stays a separate run
factory ([BRIDGE-COMPUTE.md](BRIDGE-COMPUTE.md)).

| Piece | Job in Room |
| --- | --- |
| **Cua Driver** | Host desktop automation (macOS / Windows / Linux) via CLI, MCP (`cua-driver mcp`), or SDKs. Background delivery when the OS allows. |
| **Cua Fleets / Sandbox** | Isolated cloud (or local) desktops. Claim from a pool. Shell + screenshot + GUI. |
| **Lume** | Local macOS / Linux VMs on Apple Silicon. Later only — not this phase. |
| **Cua Bench** | Tasks, evals, trajectories. Optional receipt export. Not launch-critical. |

Do not vendor the OmniParser AGPL extra by default.

## Computer-Use 2.0

Cua's framing: the harness chooses among **code · structured tools/MCP ·
GUI**, not screenshot-only. Driver is the UI tool layer. Room (or the seated
agent's host) brings the model and the Work Item.

Copy that three-surface language into later Room tips if it helps agents
pick a path. Do not collapse it into Compute Start.

## Grok Bot path

This page is for [Grok Bot](https://cua.ai/docs/use-cua-with/grok-bot), the
persistent cloud agent — not Grok Build's local stdio MCP.

Two ordinary routes. One advanced route.

1. **Local-command `cua-driver`.** Install Driver on the computer that has
   the apps. In Grok Bot, set **Settings → General → Agent → Execution on
   Local Computer** to **Ask every time**. The Bot runs `cua-driver call …`
   as local commands. The operator reviews each command before it runs.
2. **Driver on the agent's own machine.** If the GUI being driven is Grok
   Bot's cloud computer, install Driver *there* and call `cua-driver` on
   that machine. Do not point it at Potter's laptop.
3. **Custom public MCP tunnel — advanced only.** Public MCP OAuth is
   **not** the default Grok Bot path and is not this kit. Grok Bot can
   reach a public custom MCP server; Cua Driver's MCP is local stdio (or
   a loopback HTTP listener). Bridging the two needs an authenticated
   TLS tunnel, a host-generated bearer token, a bounded capability
   manifest, and a revoke path when the task ends. Cua does not ship a
   managed public gateway. Do not treat a tunnel or remote OAuth as the
   default kit.

Start with a read-only check (`cua-driver call list_apps '{}'`) before any
click. Fresh window state, act through an `element_token` from that state,
then verify. Stop for approval before send, publish, purchase, delete,
permission change, or production writes.

## Safety

**Dual boundary.** Grok (or host) approvals control whether a command may
run. Driver permission mode controls what that command may do. Keep both
on.

- No unrestricted Driver daemon for routine use.
- No Grok Bot **Always allowed** for routine desktop control.
- No people-data in desktop receipts or kit copy (no emails, account ids,
  display names).
- **Fleet Receipt screenshots must never include people-data** — faces,
  PII, or a private inbox. Call this out on any future UI string that
  attaches a screenshot path to a Receipt. Omit the capture rather than
  post one that shows a person or private mail.
- A Room key is not a Cua credential. A Cua credential is not a Compute
  provider token.
- Do not drive Potter's personal laptop without an explicit opt-in and
  Ask every time.
- Pause / Remove in Room cannot stop an outside Driver process. Same
  honesty as [AGENT-CONNECTION.md](AGENT-CONNECTION.md).

Fleet isolation matches Room's multi-agent needs better than driving the
operator's real pointer. Prefer a claimed sandbox when the task does not
need a specific local app.

## Links

- Source: https://github.com/trycua/cua (MIT)
- Docs: https://cua.ai/docs
- Grok Bot: https://cua.ai/docs/use-cua-with/grok-bot
- First Fleet tutorial: https://cua.ai/docs/tutorials/your-first-cloud-fleet

Install, doctor, and permission steps live upstream. This repo does not
restate them as a second source of truth.

## Phases

| Phase | Work | Status |
| --- | --- | --- |
| **1 Docs / kit** | This contract + catalog row + host cross-link. Optional later kit card: **Connect Cua desktop** (alt: Cua Driver MCP), under Connect only. | This PR |
| **2 Fleet claim on Work Item** | Optional Room → Fleet claim for a seated Work Item. Credentials in Room secrets. Sandbox URL + last screenshot on the thread. Session join / leave + Done chip + Receipt. | Spike only: [CUA-FLEET-SPIKE-2026-09-17.md](../research/CUA-FLEET-SPIKE-2026-09-17.md) |
| **3 Lume later** | Local Apple VM for a seated human Mac. Community Macs stay on Compute. | Later |
| **4 Bench optional** | Export a trajectory next to a Room Receipt. Offline eval. | Optional |

Phase 2 does not ship from this PR. No Terraform. No production Fleet
button.

## Steal the product shape (use the binary)

Even while using Cua:

1. **Desktop Work Item** — claim a Fleet sandbox for the item; stream a
   receipt (screenshot path + shell log) into the thread. **Fleet
   Receipt screenshots must never include people-data** (faces, PII,
   private inbox). Call this out on any future UI string.
2. **Three-surface picker** — Code / API-MCP / GUI in Room tips. Compute
   stays separate.
3. **Background delivery** — agents act without stealing the user's
   pointer when the OS allows.
4. **Bench-as-receipt** — trajectory JSON beside the Receipt, with the
   same honesty language Compute already uses (`UNKNOWN` when unmeasured).
5. **Pool claim lifecycle** — Fleet claim / release maps to Work Item
   session join / leave + Done chips. See
   [WORK-ITEM-SESSION.md](WORK-ITEM-SESSION.md).

## Non-goals

- Fork or rewrite Driver / Fleet / Lume.
- Stuff Cua into Dasha Compute Start.
- A live `/room/kits` door, App Store row, or marketplace shelf.
- Replacing Join or Connect CTAs with this kit.
- Public / remote MCP OAuth as the default Grok Bot path (tunnel =
  advanced only).
- Instinct Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
  [#9](https://github.com/Uuriko/project-room/pull/9).
- Quill / inbox / WhatsApp client paths.

Enrollment is unchanged. Ordinary connect stays packet / guest-agent /
Add agent ([AGENT-CONNECTION.md](AGENT-CONNECTION.md),
[AGENT-HOSTS.md](AGENT-HOSTS.md)).
