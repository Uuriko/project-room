# v46 historical writer fixture reconciliation

Test-only source `6e1d3bfdb53ead27fd515192612e79516c8e4023`, base `ac0a9c8e50658a6b2411e60d321c4b12839be78a`, Node `/Users/johnpotter/.local/bin/node` v24.22.1. Isolated `pr-v46-old-writer-fixtures-1104`; no Root checkout edits. No server/restore implementation, providers, credentials, Native, merge or deploy changes.

Root supplied the classified failed unit list for run41809309288. `failure-mapping.json` maps the exact10 assigned failures to nine files and their precise repairs. Locally the entire assigned cluster reproduced63tests/53pass/10fail before edits, then63/63pass/0skip after. No original test case was dropped, skipped or timeout raised.

## Preserve two independent refusal boundaries

Genuine archived runtimes remain byte-original, including native2/3/4/5 schema45 sources. They are NOT patched or registered with function46. After a genuine46 upgrade, old prepared writes to globally fenced room/event tables explicitly fail `no such function: project_room_writer_v46`; cold old constructors explicitly fail `Database schema is newer than this service`. Warm old format/context read/command refusal assertions remain where reachable. Additional prepared writes on actual current46 connections still reach `unsupported current room writer` inside a normal transaction, retaining the normalized-format permit checks separately. Existing full selected authority snapshots stay unchanged.

Consent is a distinct case: dm_consents is protected by the normalized guard rather than the global table fence. Its old45 prepared SQL still reaches the ORIGINAL format refusal. The inherited empty-database fixture had selected scratch guards from current-only writerFenceDefinitions (now46), so it installed none under its hardcoded45 filter. It now explicitly generates historical fenceDefinitions(45); this is fixture DDL only, with original empty-head/clear-admission checks retained. Current46 consent refusal and cold45 schema refusal are also asserted.

The assistant test no longer claims45 can operate a46 database. It asserts exact cold refusal/unchanged auth state, validates the real current member, and preserves the original populated45→current additive-index upgrade:2000 existing terminal rows plus accounts/member bindings/credentials/connections/events/commands/native records/proofs stay byte-identical. Schema45 before/current after is explicit.

Malformed claim table recreation now removes mandatory46 claim triggers, so the startup boundary correctly reports writer-fence reconciliation first. The actual durable claim schema verifier is also directly asserted to reject every original damaged case. All unchanged-DDL, missing-table, read-only and atomic-addition/commit-fault checks remain.

The replay-cutover test used current RoomStore throughout; only its stale version45 name/assertion/body copy changes to canonical current schema. H bytes, prospective tail proof and final witness checks remain.

## Exact qualification

```
node --test --test-concurrency=1 tests/current-browser-attachments.test.mjs tests/current-claims-old5-fence.test.mjs tests/current-dm-consents.test.mjs tests/current-history-old4-fence.test.mjs tests/current-message-redaction.test.mjs tests/current-operator-purge.test.mjs tests/normalized-room-assistant.test.mjs tests/work-claim-schema.test.js tests/replay-cutover.test.mjs
```

Before10fail; after63pass/0fail/0skip (~8.43s local elapsed, not a production performance claim). Targeted ESLint exits0 with one PREEXISTING prefer-const warning at current-browser-attachments line3. Whole secret scan0, diff check0. Logs are compressed verbatim; SHA256 hashes are in qualification.json. No manifest regeneration is needed because only tests/evidence changed.

## Remaining scope

Root owns the separate restore45/46 boundedness and actual Native packaged archive failures; authority_review owns catalog/chaos import fixes. None were rerun or declared green here. These nine files include unchanged bounded Node HTTP/recovery controls, but do not constitute full-suite or Native qualification. Historical fixture DDL is only for verified empty test targets; it is not an authorized production conversion or grant bypass.
