# MCP binding for Project Room work receipts (draft, v1)

Status: proposed convention. Not part of the MCP spec. Complements
Tool Outcome Attestations (dev.agentstatus/toa); does not replace them.

Companion to the Receipt Standard v1 attestation spec:
[spec/receipt-standard-v1.md](../spec/receipt-standard-v1.md).

## The distinction that governs this doc

**Work receipts ≠ tool-result attestations.** A work receipt (v1) attests a
completed/partial/blocked *unit of work*: claims, mechanically reproducible
observations, deliverable hashes, and mandatory non-empty `limitations`.
Tool-result provenance (MCP `_meta`, TOA, Mimir) proves a particular tool
response was unmodified or came from a named server. Do **not** emit a full
work receipt per tool call. The correct layering: tool-level attestations
feed `observations[]`/`surface.resources[]`; exactly one work receipt is
emitted per completed unit of work.

## Wire slot

`CallToolResult._meta["https://room.trydemigod.com/extensions/work-receipt/v1"]`
carries ONE complete v1 receipt object (schemaVersion
"project-room-receipt/1"), or is absent. Servers MUST NOT attach it to
every tool result — only to terminal/work-completion tools
(e.g. finish_task, submit_deliverable).

`_meta` is pass-through extensibility: arbitrary keys flow through
clients (confirmed in the OpenAI Agents SDK's MCP server surface), so no
spec change or registry listing is needed to start. This is a bilateral
convention until a SEP says otherwise.

## Layering with tool-outcome attestations

- Per-call outcome evidence (TOA toa/0.1, Mimir envelopes,
  _meta.provenance) lives under its own _meta keys, owned by those specs.
- A work receipt MAY cite them: observations[] entries of
  kind "tool-attestation", detail "<scheme>:<digest>".
- A verifier MUST NOT treat a tool attestation as a work receipt:
  it has no declaration, no limitations, no issuer work binding.

### About TOA (checked live 2026-09-25)

Tool Outcome Attestation is an Extensions Track SEP submission tracked at
modelcontextprotocol/modelcontextprotocol#3350
("SEP submission: Tool Outcome Attestation extension (dev.agentstatus/toa)",
open and live as of the check above). Its premise is exactly ours:
"Protocol success (JSON-RPC ok / HTTP 200) is not delivery success."
Incubating id `dev.agentstatus/toa` (SEP-2133 reverse-DNS for
agentstatus.dev), primary protocol target `2026-07-28`, portable signed
`toa/0.1` evidence format (offline verify, no vendor account required), with
a reference implementation at https://github.com/Carmel-Labs-Inc/toa
(MCP Python SDK `ToaAttachExtension`, conformance tests, fail-closed
semantics).

**TOA is incubating, not ratified; if it changes wire shape, this doc must
track it. Do not freeze a dependency on `toa/0.1` field names.**

## Capability advertisement

Servers that can emit receipts SHOULD declare the extension URI
(https://room.trydemigod.com/extensions/work-receipt/v1) in their
implementation capabilities so clients can discover it, mirroring the
A2A AgentCard pattern.

## Verification order

1. Verify the v1 receipt per spec/receipt-standard-v1.md (fail-closed
   issuer binding; integrity-only iff the caller opts in).
2. If observations[] cite tool attestations, verify each under its own
   scheme. A valid receipt with unverifiable tool citations is still a
   valid receipt — the citations are observations, not the trust root.

## Anti-patterns (kill on sight)

- A receipt on every CallToolResult. One receipt per unit of work.
- Synthesized limitations ("as an AI language model…"). The emitting
  server's operator MUST supply real limitations; empty → no receipt.
- Treating _meta presence as MCP-standard. It is a bilateral
  convention until a SEP says otherwise.

## Risks and known limits

- There is no official `_meta` key registry; a second project can squat a
  colliding key. The URI-key form above is collision-resistant but ugly —
  say so.
- The OpenAI forum thread of 2026-09-25 (asking for signed MCP
  requests/results) shows demand but also confusion between authenticating
  the *caller* and attesting the *result*; keep those separate.
- Mimir is a standalone product with its own spec — interop, not
  absorption.
- `limitations` cannot be synthesized. It is non-empty by spec and must
  be caller-supplied per run. Any emitter that auto-fills boilerplate
  is manufacturing compliance theater. No limitations → no receipt.
- Fail-closed identity binding travels with the receipt. Verifiers must
  not silently opt into integrity-only mode to make demos pass.
- Do not invent standard-ness. `_meta` keys are bilateral until a
  SEP/registry says otherwise. This doc stays labeled "proposed
  convention" until it isn't.
