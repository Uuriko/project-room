# Complete agent work inside a room

September 8, 2026 · implementation plan · local-only

The user resumed the full long-running goal. Previous turn: progress—owner-managed
connections and local MCP were implemented, tested and packaged. This is a new
substantive slice, not evidence that the larger objective is complete.

## Problem and intended value

An attached agent can read work and return a draft but cannot use the existing
work lifecycle through MCP. It must learn raw event shapes or ask a person to
translate each transition. This interrupts useful cooperation and obscures the
difference between a draft, reported completion, independent review and approval.

Give agents explicit tools for the existing lifecycle, with the same current
permissions and revisions as the browser/direct API. Preserve the calm chat/work
surface; no new dashboard or simulated presence. Success is two real participants
coordinating through one room and returning independently reviewed results while
the human decision is visibly still pending.

## Research and decisions

- [MCP 2025-11-25 tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
  provides input contracts, human-readable names and structured execution errors.
  Apply these to explicit Room transitions; annotations do not grant authority.
  Keep the existing pinned, quick, tools-only protocol. Experimental MCP Tasks are
  execution wrappers, not our work database, and are unnecessary for these writes.
- [Paperclip issues](https://docs.paperclip.ing/reference/api/issues/) separates
  expected-state checkout and running ownership, and gives agents actionable
  denial paths. Apply the pattern through our atomic claim/release and revision
  checks. Do not copy its broader default permissions or equate a Room member
  with a new execution identity. Leases still do not fence external processes.
- [Linear agent interaction](https://linear.app/developers/agent-interaction)
  distinguishes agent activity from the issue itself. For Room, a tool call,
  recorded result and human approval remain separate facts. Useful handoffs carry
  evidence and a next actor rather than a fabricated running/finished badge.

These are design inferences from primary documentation; no third-party code or
dependency is imported, and no native host compatibility is inferred.

## Contracts

One descriptor registry supplies strict tool inputs, descriptions and mappings
to the existing command types. The reusable client action helper builds one exact
command and checks one exact receipt. The MCP transport stays transport-only.

Expose propose, accept, start, block, resolve blocker, record completion, record
verification, acquire claim, release claim and supersede. Retain the existing four
tools. Do not expose human decisions, member management, paid execution or a raw
arbitrary-command escape hatch. Per-tool descriptions state required authority.

Existing enrollment remains chat, contribute or reviewer. None grants steer or
external-write authority; tools cannot widen that. Managed-agent integration tests
cover contributor/reviewer journeys. The synthetic claim/cross-review exercise
uses explicitly identified operator-provisioned agents with the pre-existing
combined capabilities. It is not evidence that the owner enrollment presets can
issue those capabilities. Versioned standing charters remain a separate milestone.

All mutations require a caller-chosen stable request ID. Existing tasks require
the exact expected work revision. Verification also requires the exact completion
event and evidence version inspected. Preserve optional null versus omission and
ordered arrays; no implicit acceptance, claim, lease renewal, producer attribution
or rebasing. Do not block historical retries using current suggested UI actions.

Receipt validation binds room, actor, command type, causal event, exact data,
positive sequence, event ID and SHA256(member + ':' + requestId) idempotency key.
Return the recorded operation/revision and duplicate flag, explicitly not current
ownership or approval. Fresh selected context is a separate read; a stale retry
must never be presented as a renewed claim. Unknown outcomes retain exact input.
Known post-ledger refusals distinguish conflicts from access/transport failures;
never echo untrusted service diagnostics or credentials. Evidence references are
not fetched. A stopped transport is not proof of an undone business operation.

Tool input validation covers exact fields, bounded text/arrays, IDs, safe revisions
and the existing command-byte limit. Keep schema9 and all service semantics.
Package the new reusable module explicitly; no new dependency or hidden download.

## Validation and independent participation

1. Unit tests map every action to exactly one command, preserve optional fields,
   reject unknown commands/properties and validate malformed receipts/arrays/IDs.
2. Actual HTTP/MCP subprocess tests: managed contributor and reviewer; rework;
   current and historical review; wrong actor; exact retries across restart;
   changed input conflict; cancellation/late results; no evidence fetching.
3. Claim tests use existing operator-authorized identities: competing scope,
   disjoint scope, expiry, release, historical replay after another holder starts.
4. Two independent agents in one disposable room: independently accept their own
   assignments; A acquires a fictional shared scope; B encounters conflict and
   authors a blocker; A reads it, writes its own result and releases; B reads the
   handoff and proceeds. A retries its old successful claim without restoring it.
   Both independently inspect/hash the other's submitted short artifact and record
   exact-version findings. Stop before human approval. Root seeds only the brief,
   identities and assignments; participant prose/commands must be their own.
5. Inspect the resulting human browser journey on desktop, mobile and enlarged
   text with screenshots. Verify both read markers stay unchanged, results remain
   discoverable, and the human gate does not become silently approved.
6. Run syntax/core, browser, local Workers, assets/bundle and exact cold package
   gates. Preserve historical packages. This slice does not qualify v8 as a v9
   fallback; a distinct lifecycle-aware v9 release fallback remains necessary.

## Now, next, later

Now: full thin-agent lifecycle, real cooperation, accurate documentation/evidence.
Next: bounded actionable discovery/discussion, native-host acceptance, room-native
evidence, v9-compatible release recovery and versioned standing charters.
Later: isolated work attempts, enforceable execution fencing, Dasha fake-runner
contracts, explicit subscriptions/delegation, hosted help and remote OAuth MCP.

No live access, push, deployment, migration, provider/DNS/account changes, personal
inbox reading, payments, paid compute, outreach or recurring automation is authorized
by this local slice. Continue the larger goal after a verified checkpoint.
