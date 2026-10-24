# Linked draft refinement

## Outcome

**Refine draft** creates a separate editable draft linked to the original contribution. It starts with the original text unchanged; the person deliberately decides what to keep, remove or rewrite. An optional **Original** disclosure keeps the source/notes available while editing. Posting preserves the original and every existing result and review. The accountable participant may subsequently adopt the new exact text through the normal result flow. A refined result has an **Original** action back to its same-work source conversation.

This addresses a concrete finding from the preceding actual manual acceptance: the welcome artifact and its check notes returned in one message. That turn was progress—an original coordinator answer went through the real product, with simulated owner actions and exact result evidence. Here the usable text can become a separate artifact without deleting the notes, inventing check success or silently modifying reviewed bytes.

## Research and choice

GitHub's review panels keep the changed code and contextual comments available side by side, while Linear's documents combine version history with attached discussion. The transferable pattern is separate content and conversation with an easy path between them—not more disconnected dashboards. [GitHub review panels](https://github.blog/changelog/2026-03-19-view-code-and-comments-side-by-side-in-pull-request-files-changed-page/), [Linear documents](https://linear.app/docs/documents).

Three approaches were considered:

1. Strip inferred check-note sections while importing. Rejected: arbitrary text is ambiguous, and hidden transformations would weaken exact evidence.
2. Introduce mandatory artifact/notes fields across every message, packet and tool. Not selected for this interaction: it would force routine conversation into a larger form and would not repair already-returned mixed answers without a deliberate selection step.
3. Create an explicit linked refinement using the existing immutable message/reply and result model. Selected: browser, direct API and MCP can express the same operation; original context survives and the new artifact gets its own result/review boundary.

This is not a claim that structured artifacts or check records will never be useful. A typed optional artifact/notes contract remains a possible later extension. This feature does not infer such a structure or misrepresent a reply as verified derivation.

## Contract and interaction

- Refine appears only on work-linked proposal messages, not every casual chat message. It uses the existing draft dialog, with the original collapsed by default. No new top-level navigation or dashboard.
- Private drafts are keyed by route, task and original message as a tuple. Refining A, refining B, starting an unrelated native draft and pasting an AI answer do not overwrite one another. Closing preserves text; identity reset clears it. Source text is cleared on close/reset.
- A refinement uses the work revision observed when its editor opens. Original text stays linked, not silently treated as current authority. Later work changes require the existing explicit older-draft acknowledgement. Reopening a saved refinement preserves its inspected basis.
- The new message has a new ID/correlation ID and the existing `replyToId`. The original message and its notes remain unchanged. A reply link is context, not proof of authorship, derivation, test success or permissions. It does not establish external-producer identity or reviewer independence.
- Unknown saves keep the original command, body, source link and basis locked for exact retry, even after closing and reopening. A reply field omitted from a returned receipt cannot count as confirmation.
- Saving a result still pins the new message/event and exact UTF-8 hash. It does not reuse an old approval or complete work simply because a draft was posted. Result **Original** navigation is available only after the pinned text loads and a matching same-work source exists in the current authorized room view; it is cleared on close and guarded against account changes.
- Posting reveals the exact new reply in its thread. The room-wide composer draft is restored when returning to the room; it is not the same editor context as the reply thread.

## Agent and direct-client parity

`room_post_draft` accepts optional `replyToId`, using the existing canonical `message.posted` field. Agents read the selected source/discussion first, write a separate artifact body, and retain the exact original input across retries. Notes can remain in the original message or ordinary linked discussion. The tool neither launches inference nor approves work. Its strict argument validation and exact receipt check include the link.

Direct callers can use `nativeWorkDraft(body, { workItemId, packetId, basisRevision, replyToId })` and the usual authorized command path. Server rules are unchanged: an ordinary reply must reference an existing room message; it is not a new server-enforced derivative type. The browser specifically offers refinement only for same-work proposals. MCP callers must deliberately inspect and choose their context; no stronger global source-binding rule is claimed. No storage schema, event type, migration or permission changed.

## Verification and remaining scope

Implementation checkpoint: `969425a17ccab9dbcdee8002173a42747da9bf79`. Focused browser checks initially caught a test assumption that the main composer would remain visible after opening a reply thread; returning to the room proved the draft intact. Nine focused refinement/native-result checks then passed. Final committed-runtime regression and package results are recorded below after their processes finish.

Desktop/mobile regression covers A/B draft isolation, original preservation, deliberate note removal, stale-work acknowledgement, committed-but-lost response, exact retry after switching drafts, one resulting message, a separate exact artifact result, pending review/decision, source navigation, unsent room/task drafts, identity reset, unchanged read markers and no external traffic. Direct/native helper and real MCP process tests cover reply fields and restart-safe retries; protocol tests reject malformed links and incomplete receipts. Screenshots capture editor and result on both sizes. These are scripted people/protocol actors, not independent human research or a native-model acceptance rerun.

The full goal remains active. External-producer attribution and independent review for manually returned AI work are still unresolved and must not be bypassed by labeling the refiner as a verified original author. Dedicated mailbox qualification, source rebasing, recovery limits and the wider execution/rewards roadmap remain pending. No provider, send, spending, new model, push, deployment or other product changed.

## Final checkpoint

At `969425a`, **920 core and 41 relevant browser tests passed**, zero failures, with both processes completed. Browser scope: refinement, portable work, draft return, native draft, result copy, native result and the manual-owner exercise. Logs: `test-results/refine-draft/core.log` and `browser.log`. The core suite includes direct/native draft and real MCP restart/receipt regressions. Workers and the broader Inbox browser suite were not rerun.

Screenshot review then prompted a markup-only polish: use the existing shared action-row spacing between Close and Original. At final runtime `33c817a911ebb9fb0310592cac77d8e61380541d`, **9 refinement/native-result browser checks passed**, zero failures, process completed; log `polish-browser.log`. Package comparison proves `index.html` is the only changed runtime file since the full pass; all JS/CSS and other runtime files are identical. The full core/41-browser pass was not rerun after that one action wrapper. Four final editor/result screenshots were inspected, with desktop/mobile result screens inspected again after the spacing fix.

Offline package `/private/tmp/project-room-refine-polish-YzDcbx/runtime` verifies 33c817a, schema25, 82 files and 24 public assets. Manifest SHA-256: `80795a3e8235259ab94506624e021ab6f78a40260ca5e4226d042c42bb9faf41`. The verification/comparison record is `test-results/refine-draft/polish-package.json`. Only documentation follows this runtime checkpoint. Local packaging is not deployment or production qualification.
