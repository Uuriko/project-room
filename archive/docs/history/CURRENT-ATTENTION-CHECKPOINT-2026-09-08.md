# Durable current attention: local checkpoint

September 8, 2026. The broader goal is active and incomplete. This slice is local,
not pushed or deployed. Root alone edited the checkout; three independent agents
researched/reviewed the design and contracts. Two participated in the live local
synthetic exercise. Existing user previews and unrelated products were preserved.

## Delivered

Agents can pull pending current work/instruction notices and explicitly acknowledge
their exact IDs, through CLI or opt-in MCP. Reusing the existing snapshot observer,
SQLite ownership lock and journal avoids a parallel watcher. Ordinary conversation,
UI, public assets and Room schema/writer 11 did not change.

- New local observer v2, separate from legacy foreground/stdout v1. Both modes
  refuse the other's directory without resetting or reinterpreting pending state.
  Genuine frozen old-reader refusal is tested, not simulated by a version number.
- Current semantic work conditions plus one global current instruction notice.
  Updates and clear are observed even during working state. No fabricated work
  transition, inferred obligation from prose, charter text persistence or new grant.
- Stable notice IDs/body across repeated pulls and reconnects. Pull does not ack.
  Ack reauthenticates/reconciles, then affects only its exact current notice.
  Replacement IDs survive stale ack; unknown ack can be retried with the same ID.
- At most 20 notices per pull, bounded storage/output and atomic checkpoint updates.
  Cancellation, explicit stop, ownership contention, malformed state, changed
  identity/history and revoked access fail without dismissing pending notices.
- Optional `ROOM_AGENT_ATTENTION_DIR` enables `room_read_attention` and
  `room_acknowledge_attention`: 19 tools, versus unchanged default 17. The model
  cannot choose filesystem paths. No recurring job, model, provider or server
  mutation is caused by reading or acknowledging local attention.

Independent review found duplicate persisted IDs could otherwise acknowledge more
than one subject; v2 now rejects duplicates and updates only the unique row key.
Failed first authentication no longer creates state. Retry guidance distinguishes
read arguments from retained acknowledgement IDs, and observed references from
current state. Deadline and lost-ack-response cases have dedicated MCP tests.

## Verification

Frozen source `7ac9edcbeda8e52ecc977b4ffe9f6d5b24005077`:
**475 core/API/package checks, 159 browser journeys and 12 local Workers checks
pass**, zero failures/skips; syntax checks pass. This includes 17 new attention/
MCP tests, unchanged legacy watcher tests, full browser preservation and genuine
prior-writer migration/rollback checks. The 12 Workers checks include its separate
browser adapter check; the previous checkpoint's 11-count excluded that check.
Existing local TLS-probe diagnostics did not affect passing assertions or alter
production certificate verification.

Root inspected desktop work, mobile instructions and enlarged-text reminder
screenshots. No new GUI was added; these are preservation checks and simulated
human journeys, not human preference or retention evidence. All test processes
exited. Designed synthetic Workers evidence directories remain as test artifacts,
not running services.

Exact package under the project mirror:
`work/project-room-runtime-packages-20260908/candidate-7ac9edc`.
60 files, 18 public assets, schema 11; source tree
`10642a4a170eb55c1e4a7168ab1e2600690d69fd`; manifest
`f49ec4b6bab288c3b7bd58ec6258c09ab5ce32a83949f5051cdbce99f4b0adf0`.
Cold packaged imports expose the new helper/two optional tools; populated Room
recovery/package verification passes. No new dependencies or service tables.

## Actual agent reconnect and independent review

The producer pulled/read/acknowledged initial instructions and assignment, accepted
and started the task, then closed MCP. Root changed the brief through a synthetic
owner operation. On reconnect, the producer independently discovered the new
notice and read its pointer; root did not relay the new requirements. It wrote
its own agenda, posted/submitted exact native text and checked it after reconnect.
The reviewer independently discovered its own notices, read task/brief/result,
counted and hashed the text, and recorded an honest PASS. No forced finding.

- Seed sequence 10 → final 16: accept, start, owner charter update, draft, completion,
  verification. Five participant writes plus one owner fixture update.
- Charter revision 2: `a9c2b55a-a5f0-42b7-8f6f-4ae5e5e3d8c2`.
- Producer change notice: `271869e7-866e-4046-bd3a-d684cf3ab0d3`, acknowledged.
- Exact agenda: 32 whitespace-delimited words, 230 UTF-8 bytes, named owner,
  four timeboxes totaling 20 minutes, within the new 35-word maximum.
- Draft: `68198e1f-afe0-4d4c-964d-cae1db0ce0cd`.
- Completion: `8608714a-cd1c-4f3c-9e94-1629bf5f4f4c`.
- Review: `ac3130cd-f532-47ab-b7e9-de0c4eecbbf0`.
- SHA256: `64786af157f36286d26ba80396a79a7e2cbd207610ea6720fbae5afa04c89459`.
- Final work revision 4, independent PASS, human decision null, next owner/decide.
  Human read markers all 0; both local inboxes have no pending conditions. The
  producer checkpoint is 15 and reviewer checkpoint 16, not a shared seen cursor.

Root independently recomputed body size/count/hash, checked final review/cursors,
read the two local journals, and ran the service recovery audit. Full evidence:
`test-results/attention-participant-full-20260908.json` and
`test-results/attention-local-state-20260908.json` (ignored synthetic artifacts).
The complete exercise logged 252 GETs and five POSTs; this includes repeated
agent reads, not an isolated latency benchmark. Read/ack-only integration tests
separately prove GET-only Room effects. Round-trip reduction deserves later work
without dropping identity/history checks.

The first fixture's input handle was closed before the staged owner update.
Root identified/stopped that exact process, preserved partial evidence separately
in `test-results/attention-participant-20260908.json`, and restarted a new interactive
fixture. The producer repeated phase 1 with fresh room/notice/request identities;
no false continuity is claimed. Both fixtures exited and temporary credentials,
databases and journals were removed; absence was checked. Agent processes closed.
Same OS scope-following is not process isolation or native vendor-host acceptance.

## Boundaries and next work

This is **durable local current-condition attention**, not every retained historical
cause, a direct-message request inbox, cross-device seen state, a delivery guarantee
or task execution. Conditions may coalesce between checks. Unchanged notices keep
their observed versions; `nextRead` refreshes current context before any new action.
Local acknowledgement differs from stdout written, accepted work, completed work
and human approval. No retention lift or human feedback was measured.

Recorded live remains app fb90a70 / Worker 901be347 / Room schema 7, unchanged and
not reverified. Release still needs a qualified v11-compatible fallback, hosted
restore/current-authority reconciliation and fresh approval. The older v8 switch
exercise is historical only; v10 is not a fallback for v11 data.

Next: define explicit targeted-discussion/request causes with anchored resume and
clear relevance/clearing rules, then eligible work. Reuse exact selected discussion
and keep historical causes separate from current workflow. Investigate reducing
authenticated round trips while preserving authority and restore detection. Native
host tests and release recovery remain parallel gates. Standing roles, isolated
tool/compute attempts, payments and hosted AI remain separately staged optional
work; preserve free/manual/BYO usefulness and contextual controls.

[Operator guide](CURRENT-ATTENTION.md) · [Research and plan](CURRENT-ATTENTION-PLAN-2026-09-08.md)
