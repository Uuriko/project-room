# G8 composer/download UI review

12 September 2026. Canonical new doc only. No integration edits, no new tests.

**Frozen source:** `project-room-integration` `db87e06fdc42b9735bfa441832fb19c2b5caf0f7` via `git show` (live tree was already on a search lane; composer/upload handlers unchanged per Codex). Browser journeys are Codex’s `scripts/attachment-download-check.mjs` at that commit (desktop/mobile). I did not re-run Playwright or the live full regression.

## Thread draft ownership

`ConversationDrafts` is an in-memory map keyed by `composerKey()` = `replyDraftKey(requestMode, currentThreadId)` (`conversation.js` ~283–291; `app.js` ~69, 1043). Each thread keeps its own body, recipient, reply target, error, files, and pending retry. Sign-out / revoked access replaces the whole instance (`app.js` ~173).

`DraftRecovery` scope is JSON `[roomId, account.id, authEpoch, member.id, sessionBinding]` (`conversation.js` ~296–301). A different account, membership, or session cannot restore those drafts.

**Defect (intentional policy, still a user-visible hole):** recovery **drops** any draft with `files.length` or `pending.command.data.attachmentIds` (`conversation.js` ~311–314). File-bearing composer state is memory-only. The UI tells the truth: “Reloading clears this draft.” (`app.js` ~533). After Ready, staged bytes remain on the server until DELETE or 24h expiry, but the tab no longer holds the upload IDs. Reload therefore orphans quota until expiry. FILE-ONLY doc already lists durable file-draft recovery as open.

Upload ownership: `uploadComposerFile` captures `ownerDrafts` and skips render if `drafts !== ownerDrafts` (`app.js` ~535–542, 548–554). Switching rooms/sessions mid-upload will not paint receipts onto the new composer. Good.

## Upload / cancel / retry / remove

Picker is hidden `#file-picker`; `#attach-file` (`aria-label="Attach files"`) opens it (`index.html` ~251–257; `app.js` ~544–554). Cap: 4 files, 1 MiB, sequential upload. `requestMode` hides attach (no files on specialized reply requests).

Cancel aborts `AbortController` or marks failed if none (`app.js` ~562). Retry sets `queued` and calls `uploadComposerFile`. Remove filters locally then `DELETE` fire-and-forget (`app.js` ~564–567). Lost DELETE leaves staged bytes until expiry; comment states that. Remove never deletes a committed message file.

While `pendingMessage` has `attachmentIds`, attach/remove/cancel are locked and the textarea is `readOnly` (`app.js` ~527–532, 547, 558). Lost-send retry therefore cannot pick a different file set. Codex’s browser check asserts the retried `message.posted` equals the first command, including file IDs.

**Defect:** `uploadComposerFile` swallows all errors (`catch { item.state = 'failed' }`). Client 413 text “File is too large” never reaches `#composer-status`. The row only shows “Not uploaded”.

**Defect:** `renderComposerFiles` sets `host.innerHTML` on every state change, so Cancel/Retry/Remove lose focus during Uploading→Ready.

**Correction (Codex G8 follow-up):** Download focus loss was **not proven**. `renderMessages` records `focusAction` + `focusFile` and, if the focused node is disconnected, restores onto `[data-message-action][data-file-id]` (`app.js` ~883–957). I did not run a browser focus probe; treat download focus as untested, not a defect. Composer-file `innerHTML` still has no equivalent restore.

## Unknown / lost send

Submit builds `pendingMessage` with `draftCommand` and, if a previous pending command already has `attachmentIds`, **reuses that entire `previous` payload** (`app.js` ~1738–1742). Combined with `readOnly` while locked, the user cannot edit the caption on retry. Browser check: first command response aborted after commit; second Send retries identical IDs; composer shows “Draft kept”; attach disabled.

`locallyOwnedMessageIds.add` outlives `pendingMessage` so a later refresh can still attribute the message (`app.js` ~1746–1748). Failure hint: “Draft kept. Send again to retry.”

File-only send: empty textarea + ready files is allowed (`app.js` ~1734–1736, `#message-input.required` false when a file is ready). Specialized `submitRequest` still requires trimmed text and does not attach files.

## Focus / accessibility

Download controls have `aria-label` “Download {filename}” / “Cancel download of {filename}” and a 44px min height in the Chromium check (`app.js` ~997–999; `attachment-download-check.mjs`). Composer file actions are visible “Cancel” / “Remove” / “Retry” **without** the filename in the accessible name; the name is a sibling `<span>`. Multiple files yield several identical “Remove” buttons.

`#composer-files` has `aria-label="Attached files"` but upload state changes are not `aria-live` (only `#composer-status` is `role="status"` for send). `#file-picker` is `hidden` with no label of its own (reachable via Attach files).

## Reload loss and copy

Session recovery stores text-only drafts, 12h, tab `sessionStorage`, max 50 (`conversation.js` DraftRecovery). File drafts are excluded by design. Copy: “Reloading clears this draft.” File-only messages show empty `message-body` plus download buttons; reply preview still slices `parent.body` (`app.js` ~1018), so a file-only parent preview can look empty.

Attach is hidden for reply-request mode; FILE-ONLY lists specialized request attachments as open.

## Limitations (not re-tested here)

- Did not launch Playwright; relied on the frozen `attachment-download-check.mjs` source and Codex’s reported 2 desktop/mobile passes at db87e06.
- Did not re-run full `scripts/check.mjs` (Codex said it was already running).
- Filename search after db87e06 is a separate Codex lane; not reviewed.
- Physical devices, OpenAPI/agent advertising, and public MCP file tools remain out of scope. MCP preview still has no upload tools.

## Verdict

Thread-local drafts, identity-scoped text recovery, exact lost-send retry, and download cancel/aria are real. Concrete UI defects: **no file-draft recovery (orphaned staged bytes after reload)**, **swallowed upload errors**, **composer-file innerHTML focus loss**, **composer file buttons not named by filename**. Download message-list focus restore exists in source and is **untested here**. G9 waits for Codex’s assignment.
