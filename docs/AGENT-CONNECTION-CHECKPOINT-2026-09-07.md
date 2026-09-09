# Agent connection foundation: verified local checkpoint

September 7, 2026, local time. User priority shifted from generic action-dialog
polish to seamless agent/tool connections. Root implemented the bounded foundation
after source inspection, primary-source research and three read-only reviews.

Tested source: `ba9e4bd46db613a46170abf77c9ef5f649b848dc`.
Branch: `codex/unified-local-20260907`. No push or deployment.

## Outcome

An existing agent can save one private, identity-pinned connection, check access,
read selected work and use the optional watcher without repeatedly supplying the
whole configuration. The exact room/member is checked; no browser identity is
borrowed, no task starts and no presence is invented. Legacy clients/human watchers
remain supported. The browser surface is unchanged.

Current owner enrollment is still the important missing feature. The existing
operator key is required. Local provisioning does not provision hosted storage;
the new connection command is not a key issuer or renewal operation. MCP, hosted
AI and Dasha/tool dispatch remain unimplemented. See [the plan](CONNECTIONS-PLAN-2026-09-07.md)
and [the connection guide](AGENT-CONNECTION.md).

## Implementation and review findings

- `checkConnection()` reads existing `/api/session` without history or work. It
  validates exact room/member, active agent kind, revision, known capabilities,
  expiry and absence of human-account/browser-session bindings. Result is a narrow
  metadata projection with observation time, not online/working status.
- A saved configuration contains version, fixed origin, room, expected member and
  key. New directories/files are exclusive and private; descriptor-based reads
  are size-bounded and reject links/nonregular/permissive files. File credentials
  and environment credentials cannot mix. No overwrites, automatic key rotation,
  secret-bearing URL/argument or remote error text in diagnostics.
- Every pinned operation checks access first. Snapshot, selected work and return
  brief enforce matching viewer identity. Watch startup checks before opening its
  journal. Legacy unpinned environment behavior remains available.
- Errors distinguish configuration, rejected access, wrong identity, uncertain
  expiry, rate limiting, unsupported/missing reads and transient failures. Known
  host/origin/proxy errors point to configuration, not needless key replacement.
- Runtime packaging includes the new local module when present. Literal-import
  closure requires it in new packages while frozen historical packages remain valid.
  No new public asset, service route, database schema or dependency.

Read-only review caught and root fixed save/read size asymmetry before directory
creation, a test accidentally using the old rotated key instead of the newly
revoked key, and imprecise diagnostics for known address/origin failures. A prior
CLI test expected old prose; it now checks the structured usage error and retained
secret protection. No outstanding blocker was reported by the source reviewers.

## Verification

| Gate | Result |
| --- | --- |
| Syntax and core/API | 395 passed, zero failed/skipped; final run after source commit |
| Human browser regression | 112 passed, zero failed/skipped; simulations, not recruited humans |
| Local Workers | 9 passed, including exact committed candidate → pause → frozen baseline → candidate |
| Public assets / bundle | 15 assets, unchanged 203,302-byte bundle |
| Exact runtime package | 50 files, schema v8, independently verified |
| Cold packaged agent client | Successful metadata check from `/private/tmp`, empty environment except config, no checkout dependencies |
| Actual agent | One fresh participant read the task and created one original conversation draft |
| Screenshots | Root viewed actual contribution on desktop and emulated mobile |

The new connection tests are included in the 395, not extra participants. The
full 112 browser suite passed; subsequent changes were isolated to the agent CLI's
fixed diagnostics, test targeting and documentation, with final core/Workers runs.
Known synthetic Workers TLS rejection diagnostics did not require disabling TLS.

Runtime directory outside source:
`../project-room-runtime-packages-20260907/candidate-ba9e4bd`.
Source tree: `cb08f0eec508b350272e6b972f9a153952135146`.
Manifest SHA-256:
`2577fa3060015907cbd14ba6106981b7b94acf4f50b54ca421c4760b4f721106`.

Frozen baseline remains `7075c1ddfe5ced3ae970f817dbfd0fc3e88a13b6`, 47 files.
Switch tests preserved/audited all 18 tables with idle writer permit zero. Frozen
baseline ignores pause: independent traffic blocking or a separately qualified
pause-capable fallback remains necessary. This is not provider PITR, live migration,
current restored authority certification or Node-to-DO automatic data failover.

## Actual agent exercise

Root created a disposable room and an agent with conversation-only permissions.
The operator prepared its saved connection. A fresh agent read the new guide,
checked its own identity, fetched `welcome-draft` with source excluded, then
intentionally posted its own response:

> Welcome to Project Room—share one question you’d like us to explore together.

Command `connection-welcome-draft-20260908-0600`;
message `81f2710c-87ce-47c7-b235-21ac8627e6ae`;
packet `d3862140-7848-4b1a-aafa-d7d4d52c2686`.
Sequence 4 → 5; one new message; duplicate false. Agent and root readback agreed.
Work stayed byte-identical, proposed at revision 0. Agent cursor 0; root separately
checked owner cursor 0. No acceptance, execution, completion, review or approval.
Manual-unverified proposal attribution was preserved; this test does not establish
organizational independence or verified provider identity.

The participant reported no operational errors. It needed the client-reference
document to discover snapshot/message/read-marker readback. Root permitted that
document and added a direct reference plus concrete readback guidance. A first
screenshot selector matched both catch-up and conversation; root corrected it to
the exact message row. That was a test selector issue, not a duplicate submission.

Local evidence:

- `test-results/connection-agent-desktop.png`
- `test-results/connection-agent-mobile.png`

Root inspected both: the draft appears under its agent author in normal conversation;
desktop work remains awaiting human acceptance. The header's existing Connected
label still describes the browser service connection, not this agent. Mobile is
emulation, not a physical-device study. No new UI was required for this contribution.

The verified test listener was stopped; its synthetic database and private agent/
owner credentials were removed by the fixture lifecycle. No other preview or live
room was changed. Synthetic Workers recovery evidence remains intentionally local.

## Next

Build owner-managed Connect agent, including minimal explicit access, versioned
issuance/rotation/revocation ledger, sponsorship policy, exact response-loss retries,
and qualified schema recovery. Then add a host-tested thin MCP adapter and fake-backed
tool/Compute dispatch contracts. Keep all routes tied to existing work and approvals.

The long-running goal is incomplete and currently paused in the app; this turn did
not resume, replace, complete or block it. No publish, provider/account/DNS changes,
live migration, paid execution, payment, outreach or new recurring automation.
