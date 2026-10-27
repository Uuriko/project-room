# Inspect a local Room host without starting work

Run this on the laptop that owns the journal, using Node 24.19 or newer:

```sh
node scripts/inspect-room-host.mjs /absolute/private/path/journal.sqlite
```

This command reads existing local evidence. It does not connect to Room, load a
provider credential, start a model, migrate a journal, or change delivery state.
It omits response bodies, connection identity, and arbitrary stored JSON. It
requires a private, owned, canonical journal path and checks SQLite sidecars.
Keep the journal in its original location; do not copy live SQLite files between
laptops as a way to transfer execution ownership.

## Interpret the evidence

| Field | Meaning | Next step |
| --- | --- | --- |
| `host.recent` | The saved heartbeat is recent. | Use the existing `run-codex-room.mjs --status-watch` command separately if ownership confirmation is needed. |
| `host.processOwnership: not_checked` | This read-only audit did not probe the ownership lock. | Do not infer that a process is alive from a heartbeat alone. |
| `outcome_unknown` | An intent exists without a saved result. | Reconcile the original attempt. Never launch another model solely because the first host is unavailable. |
| `saved_awaiting_delivery` | Response bytes exist and the local delivered flag is unset. | Revalidate the original request through the existing runner before delivering the same saved response. The audit does not validate response contents. |
| `locally_delivered` | The local journal recorded delivery. | Verify the remote receipt when current acceptance matters. A local flag does not establish current access. |
| `journal.truncated: true` | Only the first 100 IDs were inspected. | Treat counts as a sample, not a global backlog or health result. |
| `journal.state: missing` | No journal exists at the supplied path. | Check the configured path; absence is not proof that no attempt occurred elsewhere. |

The journal records opaque hashed request IDs. This command does not bind them
to a selected room, request or current host session. A previous session's saved
response must not be presented as completion of a new request. The audit always
reports remote state as unchecked, model execution as unproven, and execution
authorization as false.

Host metadata and journal state are read separately. They are observations, not
an atomic cross-process or cross-device snapshot. A missing, stale or future-dated
heartbeat cannot grant authority. Even a recent `running` heartbeat is a report
from a process, not a model-execution receipt.

## Two-laptop handoff

1. The owning laptop runs the command and records the observation time and
   source revision with its report.
2. Share the diagnostic output through the existing Room artifact path. Do not
   upload the journal, provider profile, credential files or saved response text.
3. The other laptop checks the exact request and attempt against current Room
   state using its own identity. A diagnostic is not a transferable claim.
4. If a result was saved, keep delivery on the original journal and existing
   idempotent response path. If the outcome is unknown, preserve evidence and
   reconcile before changing ownership.
5. Continue independent work while the affected attempt is unresolved. Do not
   block all local testing on production readiness, and do not turn notification
   delivery into a claim of execution or completion.

## Discovery troubleshooting

Local stdio and hosted MCP have different catalogs. Local stdio's
`scripts/agent-mcp.mjs` is not a proxy for every hosted action. Hosted MCP supports
`tools/list` with `profile: "lean"`; this includes `room_search_actions` and
`room_run_action` for the long tail. Core and full catalogs intentionally omit
those two meta-tools while allowing their invocation. A missing tool in one host
does not prove that the server lacks it, or that the current identity may call it.

Inspect the actual connection surface and its current advertised tools first.
Use existing identity and membership; do not mint replacement credentials to
repair discovery. Choose hosted lean discovery when supported, or use documented
direct client operations with the same identity. Do not claim newer tools such
as repository mapping are installed solely because another server revision has
implemented them.

Validation: `node --test tests/host-continuity-inspection.test.js` covers privacy,
immutable inspection, old schemas, bounded results, active writers, stale
heartbeats and unsafe paths. Existing host-status tests own live ownership
verification; this audit deliberately does not duplicate that authority.
