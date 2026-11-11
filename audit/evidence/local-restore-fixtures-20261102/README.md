# Reconciled local restore regressions

Base `197df722d6cd5b6a6e2a1177a3e4e29e046e09f2`; test-only fix `565476045a9c51e78f758dec177c48068ec5e932`. Original2failures reproduced; complete affected files now63pass/0fail/0skip. No runtime edits or waived checks.

`restore-legacy-write-proofs` called its source current but hard-coded exported schema44. The current writer/export contract is45. The fixture now compares to STORE_SCHEMA_VERSION while requiring>=44, keeping modern exports outside explicitlegacy42/43attestation. Once the stale assertion is passed, existing file/buffered/stream missing-proof and conflicting42attestation negatives all execute and pass. Genuine historical42/43 adoption, Unicode coldwrites and unchanged historicalverification cases remain.

`room-backup-export` expected only four skipped tables, omitting two now-seeded target-owned controls. `room-export.mjs` deliberately discards imported current_room_writer_permit/current_restore_admission rows even if targettablesexist. The fixture now also injects a forgedopenpermit and pendingadmission (one seeded+one forgedrow percontrol), expects bothcounts2, and directly verifies restoredpermit remainsclosed/null-bound and admissionclear with no sourceseal/coverage. Unknown-table rejection and existing trailer/content checks remain unchanged.

Commands, exactbefore/afterfull logs and hashes accompany qualification.json. FocusedESLint and secretscan exit0. These were fixture drift, not implementation defects; no recovery or identity requirement changed.
