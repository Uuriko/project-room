# Remaining historical Board fixture reconciliation

Base `5c8b5632b2535f5e36392c0c7636c7f93468cbcc`; tests-only source `dedeb4b16`.

Four fixture changes use the already-integrated genuine legacyAgentRoom helper: agent-read-path Board triage, hosted claim-thread, hosted claim provenance, and bundle-less redelivery review. All original assertions remain unchanged. No production code, permissions, identity, credentials, schema, or native Board behavior changed.

Exact four-file baseline: 23 tests, 19 pass / 4 fail, each setup refused with legacy_work_retired because production AgentRooms creates normalized rooms. After fixture reconciliation: 23 / 23 pass, 0 skips. Targeted ESLint: 0 errors and one preexisting prefer-const warning at work-claim-provenance.test.js:103.

Whole-tree scanner remains red on unchanged server/current-room-events.mjs:55 dense-expression high-entropy finding from the pinned base. This lane neither changed that file nor added an exemption; root was notified.

Existing native coverage remains separate: normalized-needs-me.test.mjs proves protected current work/request discovery and private-source continuation; current-work-handoff.test.mjs proves exact retry, actor/revision/evidence constraints, halt/resume and full recovery; current-work-list.test.mjs proves canonical saved-completion pointers. Historical claim thread/provenance and Board deliveryGeneration are not claimed to be native features or equivalent native contracts. These are Node/local HTTP/MCP tests, not actual Worker or live qualification.
