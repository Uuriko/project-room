# Focused discussion and deeper agent participation

September 8, 2026 · local checkpoint, not pushed or deployed

Tested runtime: `ced1ccce69ea44e819a16b47c1101a2b6ad465c2`. Later changes are
test/evidence-harness/documentation only. Schema remains 9; recorded live app
fb90a70 / Worker901be347 / schema7 was neither reverified nor changed. The broader
goal remains active and incomplete. This is not native vendor-host acceptance,
isolated execution, hosted automation, human-user research or live readiness.

## What changed

Added `workDiscussion`, its authenticated endpoint, CLI `discussion` and MCP
`room_read_work_discussion` (15 tools total). It returns exact selected source,
linked drafts and reply descendants, with event/message identity and attribution.
Default20/max50 rows,64KiB row budget, explicit continuation, frozen horizon and
separate current work. Full text, no implicit all-room read or read-marker writes.
Other-work branches, unrelated threads, private reminders and reactions stay out.
Existing workContext/source defaults, permission model and human UI are unchanged.

Static reviewers identified and root fixed client continuation-window binding and
misclassified CLI argument failures. Fixed MCP refusal text gives actionable next
steps without echoing private diagnostics. Root documented numeric since/checkpoint
as an unanchored filter: after known/suspected history recovery/replacement, reread
from the start. It is not the watcher's durable, history-bound processing cursor.
Anchored pagination is not a cryptographic proof of the entire history prefix.

Three independent research/review lanes completed; root remained sole code editor.
The implementation deliberately adds no dependency, schema, public asset or new
dashboard. The browser shows contributions through its existing conversation and
View latest draft link.

## Actual agent exercise

One actual participant, through separate real MCP processes, read a newly created
synthetic room. Root supplied no draft answer. The source requested a three-step
checklist; a later owner reply requested two sentences, no more than30 words, an
invitation to offer a question/idea and human review before approval. Work revision
stayed0. The unrelated picnic message was excluded from the selected discussion.

The participant explicitly paged with limit1, identified the clarification and
author, refreshed at checkpoint7, read current work, and authored this20-word draft:

> Welcome to Project Room, and please share one question or idea. A person reviews the work before it is approved.

It posted once and replayed identical input. Original receipt duplicate=false,
retry duplicate=true, event `d05ad3ba-db26-4597-8e46-5309502d8eff`. Selected readback
matched exact author/message/body/packet/basis. Draft112 UTF-8 bytes; SHA256
`69f9e40fee6551e312e121af45b1b6983aede4f44bfa39a978b7e9e5edd2b386`.
Root independently checked persisted evidence: seed7→final8, one participant
message event, both cursors0, work proposed/revision0, no completion or decision.
The original posting identity is authenticated; outside authorship remains the
existing `manual-unverified` label. No native-vendor identity claim is made.

Evidence: `test-results/discussion-actual-agent-20260908.json`, SHA256
`db6b9b77e2c6d038d49fe89fbb2ebd751757e6399cc75055d7b02f8f407c3d6d`.
Root viewed desktop/mobile and200%-root-text screenshots, including separate
beginning/end reading views for oversized text. No document overflow, page errors,
off-origin requests or non-login browser POSTs. These are simulated human UI
checks, not proof of preference, retention or native browser zoom behavior.

Final captures: `test-results/discussion-actual-agent-20260908-v2-{desktop,mobile,
mobile-large-text,mobile-large-text-end}.png`; browser evidence JSON alongside.
Earlier screenshot set is retained, not overwritten. The fixture listener exited
normally; its exact temporary directory/database/private keys were removed, and
absence verified. Existing previews and live rooms were untouched.

## Verification and package

- 436 core/API/package checks;121 browser regressions;10 local workerd checks pass.
- New focused coverage: inclusion/nested/shared sources, historical authors,
 115 replies and sparse events, frozen paging/new arrivals/reactions, byte bounds,
 legacy IDs, superseded/empty work, current access, continuation response binding,
 strict CLI/MCP and exact draft readback. Scripted transport tests are separate
 from the actual agent's semantic exercise above.
- Real workerd verifies the new retained-event JSON query and session binding.
 Exact cold package imports expose15 tools; its discussion read preserves populated
 schema9 recovery data. Historical v8 switch tests remain historical, not a safe
 fallback for migrated schema9 data.
- 16 exact public assets; production entrypoint bundle234089 bytes.
- Exact56-file package retained at
 `../project-room-runtime-packages-20260908/candidate-ced1ccc` from the canonical
 checkout's parent work directory. Source tree
 `47b6f23af086f13c6cc84d693dea0f121e6678c6`, manifest SHA256
 `aa7fabe79869e593dbc3e8efb771f52e2d99849296a263f3f4a0c33712c1e441`.
 The first packaging request used a short commit and was refused before creating
 any output; the exact40-character commit succeeded. No partial package remained.

## Highest-value next additions

1. Room-native versioned text results: exact bytes, attribution, revision lineage
   and review of a specific version, without synthetic evidence URLs.
2. Standing charters and eligible work discovery: useful initiative inside clear
   owner-approved boundaries, with current grant versions and revocation.
3. Durable attention for relevant clarification, assignment and review; BYO/local
   delivery first, opt-in runtime wake only after dispatch/attempt guarantees.

These priorities draw on A2A artifact lineage, Linear human accountability and
Paperclip scoped wake/handoff patterns; see the cited [workspace roadmap](AGENT-WORKSPACE-ROADMAP-2026-09-08.md).
Continue generic human action-dialog reliability, native-host acceptance and
v9-compatible fallback/hosted recovery alongside them. Then isolated workspaces,
delegation and fake-runner Dasha/repository contracts. Real provider execution,
payments, external messages, personal inbox access, new automation and publishing
still require separately scoped authority.

[Reader guide](WORK-DISCUSSION.md) · [Plan](WORK-DISCUSSION-PLAN-2026-09-08.md)
