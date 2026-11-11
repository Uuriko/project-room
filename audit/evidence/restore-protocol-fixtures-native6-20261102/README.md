# Archived restore protocol fixture reconciliation

Base `ca7508fd5d5b3bc764166d2d7a365529f6a89756`; tests-only source `5078c3b3578c543aa0907f1248fdbe32bf3d38d0`.

Four original tests archived genuine protocol15/16/18/19 runtimes with native-work-5. Their explicit verified-empty transitions installed current restore guards but left the old current_room_permit_update format token. Current native-work-6 restore correctly refused that mixed experimental setup. Baseline four-file run: 13 tests, 9 pass / 4 fail, each at the expected202 response receiving500.

A dedicated test-only helper now runs inside each existing explicit transition before restore DDL replacement. It requires the genuine archived native-work-5 token, invokes that runtime's exact current schema/closed-permit verifier, and requires rooms, events, commands, messages, work_entities, current heads/records/proofs and restore scratch to be empty. Only then does it replace current_room_permit_update with the current code-owned definition, following the already-existing durable coverage fixture pattern. Existing restore guard transitions remain intact. No production upgrade, admission, schema or acceptance logic changed.

Original archive pins and all current/old-source assertions remain unchanged: old preopened, prepared and cold runtimes refuse; unsupported old continuation performs zero guard DROPs and leaves progress/receipt unchanged; supported current continuation and cleanup proceed. No assertion was removed or weakened. This qualifies synthetic explicitly unused target setup only, not upgrading existing room data or mixed/unknown runtime state.

After: 13/13 pass, 0 skips. Targeted ESLint 0 errors / three existing prefer-const warnings. Whole-tree scanner 1909 files / 0 findings. No actual Worker or live qualification is newly claimed. Root separately owns runtime upgradeUnusedCurrentFormat5; this patch is tests only.
