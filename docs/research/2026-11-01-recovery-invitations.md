# Independent invitation recovery audit (offline protocol16)

Base: `aa4a88c211cf65c956e0ae926966842de6b8a157`. Source branch: `codex/recovery-invitations-1101`. Runtime checkpoints: `d7cbb92ac` shared original equality leaf, `ffc8bc802` independent module, `40550daac` protocol16 integration, and `68553fe7e` exact SQLite candidate-selection correction. The later qualification/evidence commit contains fixture changes only.

This adds a resumable invitation check to the existing target-owned restore continuation. It does not remove the final original `auditRecovery` or `verifyInvitationAudit`, change schema45/native-work-5 serving authority, introduce a source certificate, or authorize production migration. Tested, integrated, deployed and live-verified remain separate: this lane is locally tested only.

## Missing invariant and exact authority

Protocol15 folds room events and validates several projected subsystems but does not independently reconstruct private membership invitation journals, compare their mutable record/audit projections, or prove accepted invitations against their joined event/account binding/current membership. Its final synchronous private invitation oracle performed those checks and enumerated all invitation IDs.

The new module reuses `replayInvitationJournal` from the same journal module as Store and extracts the original canonical record/audit agreement into a leaf called by both implementations. Accepted membership uses the existing membership-evidence leaf. It admits the exact joined event, member/account binding, addressed protected member/head, deleted-account exception, and self-left/rejoined exception. It creates no grants. Ordinary writes, raw SQL, mismatched pending ID, wrong seal and wrong restore phase cannot invoke the phase successfully.

A selected legacy member is read using the original roomAuthority semantics: first top-level members container as selected by SQLite, last duplicate inner member key as selected by JSON.parse. SQLite still tokenizes the admitted legacy projection. A controlled duplicate-inner-key test establishes this private-audit grammar parity, not complete global source admission.

Review found a real distinction in self-left evidence: the original SQL first selects the latest event matching SQLite json_extract type/memberId, then JSON.parse checks active/actor. SQLite uses first duplicate keys while JSON.parse uses last values. Four causal controls (both orders for type and memberId) fail405 in false-accept and false-refusal directions.685 preserves exact SQL eligibility after scalar admission, then checks only the selected event's parsed active/actor. These controlled event-body mutations establish leaf parity; they are not valid whole-source restore examples. The unchanged final original oracle remains mandatory.

## Deterministic continuation and bounds

The existing pending control now has audit protocol16 and a global invitations stage after reminders and before cleanup/engine/full_audit_pending. Prior15 cold, preopened and prepared controls refuse16 before progress; the new runtime can continue it. Cursor state contains only IDs, reverse sequence, stage and counts. No journal, projection, message body or credential enters cursor/scratch or public response. Operator progress is already privileged.

An orphan keyset walk independently rejects journal rows without invitation records. The record walk uses invitation-ID order. Each record admits scalar lengths before its payload, at most two journal rows and two audit rows, then exact replay/projection equality. Extra third rows refuse before payload. Missing-binding inactive members use a durable unfiltered reverse event walk, preserving exact latest-matching semantics without one whole-history query. Final complete counts must equal sealed record/journal/audit counts. The original final oracle's four-field summary must equal the independent summary before readiness opens.

Each call admits at most32 logical work atoms and normally4MiB source input. Source maxima and code-owned columns come from the actual target-owned seal, not a caller-supplied maximum. An individually legal fixed invitation group/event/legacy projection atom above the quantum runs alone and reports its actual admitted bytes. Thus this is restartable bounded work admission, not a strict heap/CPU guarantee. Scalar SQL/catalog/transaction overhead is not included in that logical source byte counter. A reverse-history step reloads its selected invitation envelope, and total work remains proportional to history examined; this does not make every invitation verification constant total cost.

The72-record control proves a first32-row orphan window and later complete enumeration. Tests also cover journal checksum, mutable record, audit actor, binding origin, joined-event substitution, protected-member corruption, third journal row, orphan journal, wrong authority, and scalar byte refusal before payload. Genuine account deletion and self-left/rejoin cases remain valid.

## Executable evidence

The exact command/results and log SHA256 values are in `audit/evidence/recovery-invitations-20261101.json`.

* On the original15 runtime, the new real operator test fails its intended assertion that invitation semantics must be durably checked before the original oracle. An earlier missing archive-import attempt is not counted as the causal failure.
*405 affected Node suite:125/125, no skips. This predates the duplicate-key correction and must not be represented as final-source coverage of that corner.
*685 focused module/operator/old-protocol suite:20/20, no skips. The four duplicate-key controls fail405 before the cure. Native qualification uses a legal synthetic H-converted room, accepted/revoked/pending invitations, a genuine self-left/rejoin,40 later events, actual partial import, cold readiness refusal, warm/cold continuations, exact latest retries, injected post-checkpoint save fault rollback, journal corruption refusal, final original oracle and cold readiness.
* Runtime-package source import/preflight/served-asset checks:3/3. Targeted lint: zero findings. No secret-scan exception/allowlist changes.

The Native fixture's damaged arm originally attempted a save-fault assertion after its own corruption had been injected. With random invitation ordering the damaged record can land in a later window and refuse before checkpoint. That was a fixture error; the final fixture injects checkpoint faults only on the clean target arm and independently drives the damaged arm to corruption refusal. Failed diagnostic logs are retained and not counted as green proof.

## Remaining limits

The final full recovery oracle and original private invitation audit still execute synchronously and repeat work. Other deferred/global replay semantics remain explicitly deferred to that oracle. Legal large SQLite atoms, legacy projection tokenization and the final oracle are not strictly CPU bounded. Native physical samples cover successful invitation requests only; cold constructors, native runtime permit SQL, faults/retries and the rest of recovery are outside those adapter samples. No net speedup, production latency, memory peak or full recovery bound is claimed. All data is synthetic; no retained private production snapshot was imported or published. No push/deploy/production recovery was performed.
