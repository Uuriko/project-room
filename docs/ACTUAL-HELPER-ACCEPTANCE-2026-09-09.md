# Actual helper contribution, simulated owner

## Outcome and boundary

The current coordinator AI used Project Room's direct client and separate local MCP protocol processes to discover an invitation, offer help, reconnect, author an original welcome, inspect its exact stored bytes and release the selected offer. Two explicit browser stages simulated the owner selecting the helper and adopting the draft as a result. The fixture did not prewrite the agent's answer. No additional LLM, native vendor host or paid inference process was launched.

This is actual coordinator-agent participation, not independent-agent or independent-human acceptance. It does not complete the earlier native Claude review. That earlier run remains partial, and its usage-approval boundary was not bypassed. The full Project Room goal remains active. The preceding preview turn was progress: committed runtime, tests and screenshots changed authoritative state.

The exercise ran at `8eb3ddf3ae14038a697134b4ee58eaab12788a36`, extending clean starting checkpoint `57482e8`. Runtime behavior was unchanged by the fixture commit. Account names, room, brief and credentials were synthetic. The helper used managed read-and-chat access, not an owner's credential. The simulated owner used a separate browser login. All actors shared one OS user; this is not secret-isolated execution.

## What happened

1. Direct-client access check, help-wanted discovery, selected work and source/discussion reads established the current scope. The helper was not the task's accountable member.
2. The coordinator authored a bounded plan and posted offer `actual-helper-welcome` at sequence9. A simulated owner selected it at sequence10; the task stayed accepted/revision1, owned by `owner`.
3. A fresh local MCP process retried the exact original offer input. It returned the original sequence9/event, with `duplicate:true`, while a separate current read showed selection. The old receipt was not mistaken for current state.
4. The coordinator authored and posted this 21-word draft at sequence11: “Bring a question, an idea, or something you’re making. Talk it through together, or share a small draft when you’re ready.” Another fresh process recovered the same draft receipt and fetched its exact text. No duplicated reply request or copied answer was added to the conversation.
5. The simulated owner inspected the visible text, explicitly chose the reported producer, and saved it as a result at sequence12. It preserved the owner's unrelated composer draft. The interface showed Awaiting verification, not approval.
6. The coordinator fetched that exact completion and independently recomputed its byte hash, then explicitly released the stale selected offer at sequence13. Release changed coordination only. No independent review or human decision was fabricated.

The original text is126 UTF-8 bytes. Evidence version: `sha256:ef863ea2d65915c7f29f74817020ee0b14b38e7fda42504bfc5cfb22fd399500`. Draft event: `9d7cb51a-9b60-4bc2-9dd5-9ee0749f6b71`. Completion event: `cb5070ca-81ae-4c7e-a8a0-b8772d98d505`.

Final state: work completed/revision2 (a reported result), verification null, owner decision null, offer released, all three read markers0. The selected next actor remained the reviewer. The service records authenticated membership attribution, not cryptographic proof of model authorship; the portable draft's existing `manual-unverified` provenance was intentionally preserved, and the owner-reported producer remains a report.

## Product learning and improvement

The selected response exposes invitation-specific `offers` alongside older conversational `collaboration.offer` guidance. Both are valid routes, but an unfamiliar agent could interpret them as two required steps. The tool description and help-offer guide now explicitly prioritize requested offer context and explain that the conversational request is a fallback, not a second offer. No read payload, validator, permission, tool registration, schema or business transition changed. A protocol listing regression checks that cue and still exercises the selected offer read.

The owner screens kept the conversation central and deeper controls inside the existing help/result flows. Five screenshots were captured across selection and adoption; four were inspected closely. The result form still has substantial metadata, and selecting a producer deliberately is important. Future simplification should not erase the difference between poster, reported producer, reviewer and owner decision. This exercise does not establish human delight or retention.

## Reusable local exercise and evidence

- `scripts/helper-agent-exercise.mjs` creates only a new loopback room, separate private helper/owner credentials and a pending reviewer. It reserves a new evidence file before startup, generates no participant answer, exports evidence at shutdown and removes its temporary room and credentials.
- `scripts/helper-owner-exercise.mjs` performs only an explicitly selected offer or an exact helper message adoption through a new browser context, restricted to the fixture origin. It is a simulated owner, not a reviewer or product-side automation. It requires a new output directory and preserves the chat composer.
- `tests/helper-agent-exercise.test.js` checks context-only seeding, private credential exclusion, eligible access, read markers, protocol guidance and cleanup. Automatic tests do not launch models.

`test-results/actual-helper-20260909/` contains the original offer/draft/release inputs, actual command receipts, exact-retry records, final fixture export, owner browser evidence/screenshots and a derived audit summary. The audit matches the five ordered participant events to their actors and inputs, validates result bytes/hash and references, confirms duplicate receipt identities and checks pending gates/unchanged read markers. This establishes internal evidence consistency, not independent model provenance.

The fixture process exited normally and removed only its generated temporary room and credentials. Exported evidence and screenshots remain. The old fixture cannot be resumed; repeat acceptance requires a fresh fixture. No live room, provider, mailbox, external message, money, deployment, public publication or other product changed.

## Next

Qualify independent native-host review when current usage approval is available, with the complete scoped inspection tool set. Separately test the manual packet return through the same result/review path and record its different identity/tracking limitations. Continue source/connection rebasing and recovery limits before real mailbox editing; do not let those dependencies block native conversation or agent collaboration progress.
