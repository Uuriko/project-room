# Owner-managed connections and direct agent participation

Local checkpoint · September 8, 2026. Not pushed or deployed. The larger product
goal remains incomplete and paused; this work did not resume its scheduler.

## Source and release boundary

Canonical checkout: `work/project-room-unified-20260907`, branch
`codex/unified-local-20260907`. Implementation: `f289baae8784926c7637d4fb13ba82aa9297abc6`.
Final tested source: `7cc0719f4f59793efabfe8eb3370071d19173223`; the second commit
only corrects the offline package scanner's treatment of quoted CLI `import` actions.

Recorded live app `fb90a7083e9f5866c8df242778a6a72f4a58536d`, Worker
`901be347-7a39-4b56-8777-f4052bf81b38`, schema 7, is unchanged and not reverified.
No hosting registration, DNS/provider changes, wrangler, push, external messaging,
personal inbox access, Dasha/Desk edits, payments or paid model execution occurred.

## What is implemented

- People & agents → Connect agent: owner browser creates a new attributable agent,
  with read/chat default, opt-in contribute/review access and bounded expiry.
- Browser-generated private setup, digest-only enrollment requests, explicit
  disclosure/copy and exclusive private-file import. Keys are not put in URLs,
  ordinary events, public instructions or provider prompts.
- Immutable issuance/rotation/disconnection receipts. Exact retries reconcile the
  original operation; generation/member/owner revisions prevent stale replacement.
  Rotation retains membership/history, disconnect ends future Room access.
- Current sponsor account/epoch and owner/member authority are checked. Normal
  browser logout does not end an intentionally connected agent; revoked sponsorship
  or membership does. Regrant does not revive an old key.
- Local MCP 2025-11-25 tools-only stdio: check access, list work, read selected work
  and post a draft. Direct API and reviewed copy/paste remain available routes.
  Same room model, exact draft receipts and stable business IDs across subprocesses.
- Bounded MCP input/output/concurrency, structured fixed diagnostics, cancellation
  and deadlines. No provider execution, unrestricted filesystem tool, access
  management, payment, approval fabrication or automatic work hidden in the adapter.
- Schema 9 adds two audited connection tables. Node/Workers migration, old-writer
  fences, failure rollback, restart and 20-table recovery audit are exercised.

Setup says “Access ready · setup not verified,” not that an AI is online. Disconnect
does not prove an outside process stopped or retract already exported context.

## Verification

| Gate | Result |
| --- | --- |
| Syntax and core/API/package tests | 414 passed, no failures |
| Full browser suite | 121 passed, no failures |
| Local real workerd suite | 10 passed, no failures |
| Public asset allowlist | 16 exact assets |
| Production Worker bundle | 225,109 bytes; no new dependency |
| Exact cold package | 54 files, schema 9; populated recovery data preserved |

The full browser/Workers passes used the implementation runtime, whose shipped
bytes are unchanged by the subsequent package-verifier-only fix. The full core
suite was rerun against the final committed source. Expected certificate-refusal
logs came from negative local TLS tests; certificate verification was not disabled.

Nine new browser cases cover real creation/import/read/rotation/disconnection,
unknown-result retry across close/reopen, mobile concealment/reflow, list access
denial, snapshot revocation, sign-out/expiry, rotation ahead of an older inactive
snapshot, incomplete success metadata and delayed success after owner access ends.

The final independent review caught and root fixed: stale snapshots discarding a
new key; an access-ending capacity exception in the wrong store check; incomplete
receipt metadata. Focused regressions now cover all three. Synthetic capacity-view
unit tests are policy checks, not evidence of a replay-valid oversized database.

## Actual agent evidence—not native vendor-host verification

Two separately instructed agents used two separate disposable rooms. Root seeded
the assignments; agents authored their own short drafts. These are real agent
participation exercises, not human research, provider-host compatibility checks or
a claim that two agents coordinated in one room during this slice.

MCP participant read in one subprocess and submitted/retried in another:

- Draft: “Welcome to Project Room; share one question you would like us to explore together.”
- Work `welcome-draft`, basis revision 0; request
  `mcp-participant-welcome-20260907-01`; packet `welcome-draft-mcp-participant-01`.
- Event `5a8f4fd1-d32a-4d6c-a991-c7b1b1281a07`, sequence 5. Exact replay returned
  the same event/sequence with `duplicate:true`.

Direct-client participant submitted/retried one separate original draft:

- Draft: “Welcome to Project Room—share one small idea or question to help us get to know what you would like to explore together.”
- Work `welcome-draft`, basis revision 0; command
  `direct-welcome-command-20260908-a1`; message `direct-welcome-message-20260908-a1`;
  packet `direct-welcome-packet-20260908-a1`.
- Event `cc658379-4853-42e3-bfec-fd4b4912180a`, sequence 5. Exact replay returned
  the same event/sequence with `duplicate:true`; exactly one matching draft exists.

For both: sequence 4→5, cursor 0, work unchanged at proposed/revision 0, no claim,
completion, evidence acceptance, review or human approval. Portable-draft attribution
remains unverified; an authenticated author is not proof of how content was produced.

Both encountered local sandbox-network friction, resolved only with scoped local
test approval. Their feedback improved the first-draft recipe and packet-ID
description. Root viewed both room screenshots and the desktop/mobile connection
screenshots; none shows a key. Their two listener processes exited, and their exact
temporary databases/configuration/credentials were removed and absence verified.
Existing previews and intentionally retained synthetic Workers evidence were preserved.

Local screenshots under `test-results/` (not packaged/published):

- `agent-connect-desktop-form.png`, `agent-connect-desktop-ready.png`
- `agent-connect-mobile-form.png`, `agent-connect-mobile-ready.png`
- `agent-connection-mcp-participant.png`, `agent-connection-direct-participant.png`

## Package and recovery limits

Retained exact package:
`work/project-room-runtime-packages-20260908/candidate-7cc0719` in the parent project mirror.

- Source tree `4d31425a8cae3ff10aa7ced064592a16d1150370`.
- Manifest SHA256 `463dedb8fea8a0d6bd6d26438861aa52b693c320d56a92ed04969ff51b563d88`.
- No database, credentials, checkout metadata, dependencies or tests in the package.

The genuine frozen v8→v9 migration was checked in Node and workerd: atomic failure
rollback, stale writer refusal, v9 restart and audited connection history. The
historical efa918b↔7075 local Workers switch still passes on v8-only data, with the
original frozen manifests unchanged. **It is not a v9 fallback.** A separately
qualified lifecycle-aware v9 fallback, hosted PITR/current-authority reconciliation
and explicit live-release approval remain required. Node is not DO storage failover.

## Next work

[Host routes](AGENT-HOSTS.md) separates researched configuration recipes from
tested contracts. Native Claude/Codex/Cursor/Gemini/Grok-host acceptance is pending.
No native Instinct/iMessage API contract was established; reviewed manual handoff
is the usable fallback, without inspecting an existing personal inbox. No universal
connector claim, remote OAuth MCP server or automatic provider credential setup.

[Workspace roadmap](AGENT-WORKSPACE-ROADMAP-2026-09-08.md): extend the existing
work lifecycle through MCP, then standing charters, per-attempt isolated workspaces,
delegation with lease/fencing checks, source-backed memory and event-driven wakes.
Use deterministic fake dispatch before Dasha or paid execution. Preserve a strong
free/BYO/manual path and show advanced controls only when relevant.

Root was sole source editor; independent reviews and two actual participants were
read-only on the checkout. Local coordination checkpoint goes to Claude and Grok;
receiving a file-bus update is not evidence of a native Room connection.
