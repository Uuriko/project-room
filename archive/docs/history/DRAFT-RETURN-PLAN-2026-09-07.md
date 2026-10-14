# Manual draft-return journey

## Outcome

Make the free/manual/BYO loop clear and dependable: copy a bounded prompt, deliberately paste a draft, confirm exactly what was saved, and find that contribution from its work item. Keep formal completion, provenance, independent review and owner approval separate.

Starting point: clean `eed0832`, tested runtime `5f62fd6`. Root owns integration; three agents reviewed the complete join/conversation/contribution/review/return journey read-only. This is local work only; recorded staging remains v7 and the candidate v8.

## Evidence and selection

- `portable-work.js` clears the only return draft after any parsed successful HTTP response. It also replaces an unknown outcome with editable state after a pre-ledger 429, risking a new command for an already committed contribution.
- “Add result” actually posts a work-linked conversation proposal. The work item has no reverse link to it, and a contributor in another conversation thread may never see what they posted.
- The two portable textareas inherit a fixed dialog font. Existing overflow tests did not prove actual text enlargement.
- External evidence hosting is not strictly necessary today (a reported HTTPS Room message link is accepted), but there is no native validated evidence bridge. Adding one would require separate event/replay/fallback design. Do not smuggle that change into this repair.

Primary-source inspiration, checked September 7 PDT:

- [Linear comments](https://linear.app/docs/comment-on-issues): contextual discussion, direct comment links and visible unsent drafts. Borrow the clear connection between work and its discussion; keep this product’s requested Enter behavior.
- [GitHub draft readiness](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/changing-the-stage-of-a-pull-request): distinguish contribution from readiness for review. This is an analogy, not evidence of retention lift.
- [Linear Triage](https://linear.app/docs/triage): separate incoming contributions from accepted work. Borrow the boundary, not another inbox.

Asana’s approval documentation returned a loading/CSS error, so it is not evidence for this design. Research is not user testing; no real human feedback, retention or growth has been measured.

## Implementation contract

1. Rename the visible flow to Use my AI → Paste AI draft → Post draft. Describe the persisted object as a pasted draft, with unverified outside authorship. Update exported instructions, not ROOM-RETURN v1 fields or parsing rules.
2. Add a client-generated stable message ID to the existing message command. Confirm positive sequence, duplicate flag, valid event ID, room, actor, event type and exact flat data. Only a matching owned receipt clears the form.
3. Retry the exact captured command while the outcome is unknown, without reparsing changed DOM text. Network/5xx, wrong/malformed success, pre-ledger errors, rate limiting and idempotency conflicts cannot erase prior uncertainty. Only established post-ledger rejection pairs unlock correction. Preserve one message ID across a definitively rejected correction; a separate draft gets a fresh ID.
4. Keep uncertain drafts across close/reopen within the same session; clear on access loss. Late old-session responses cannot clear, announce or navigate a replacement session. Prevent an open draft from being silently replaced by another programmatic opener.
5. After confirmation, reveal the exact message when the snapshot has it. If refresh failed, report the saved fact and ask for refresh, without inventing visibility or undoing the receipt. A contextual View latest draft link uses canonical message order; neither navigation path advances the caught-up marker. Preserve source links and thread composer drafts. Avoid duplicate Make this work on already-linked returned drafts.
6. Use shared rem-based portable textarea sizing, preserving existing responsive layout and adding actual computed-size assertions.

## Verification and limits

Add pure receipt/retry contract tests; browser cases for committed loss→429→same retry, uncommitted loss→stale rejection→explicit correction, malformed/mismatched 2xx, failed snapshot after receipt, exact navigation amidst unrelated messages, close/reopen, late session results, keyboard/touch and 200% text. Inspect synthetic screenshots. Run complete core/browser/Workers recovery gates, asset/bundle checks and an exact committed runtime package. Keep the frozen compatible fallback test.

No new table, event type, public asset, dependency, runner, AI provider, payment or background notification. Do not dispatch an agent or treat a draft as evidence. Generic action-dialog receipt/stale-revision recovery and a truthful in-room evidence bridge remain next candidates after this checkpoint.
