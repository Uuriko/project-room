# Composer upload accessibility fixes

G8's actionable composer findings are addressed:

- Upload failures retain and display their error instead of only “Not uploaded”.
  User cancellation is labeled separately. All text is escaped before rendering.
- Cancel/Retry/Remove accessible names include the filename. Visible copy stays
  short while assistive technology can distinguish files.
- Composer file rendering skips unchanged HTML and restores focus using file ID
  plus action. If an action changes during completion, focus stays on that file's
  remaining action; removing the last file returns it to Attach files.
- A dedicated status region announces upload start/completion/failure for the
  currently visible draft. It clears when no files remain, including sign-out.

Both desktop and touch/mobile Chromium journeys passed, including a lost-response
failure shown in the UI, keyboard Retry, focus on Remove after completion, Ready
announcement, and focus returning to Attach files after removal. The existing
upload/send/download, exact retry and filename-search steps remain in those runs.
26 focused draft/upload/client checks also passed. Whitespace check passed.

This is synthetic browser evidence, not a complete accessibility audit or physical
device validation. Multiple-file focus transitions and screen-reader behavior
still need broader qualification. Durable draft recovery remains open.
The earlier G8 blanket claim about download focus is separate from these composer
fixes; download controls already had keyed focus restoration.

No deployment or canonical source edits occurred.

## Combined regression checkpoint

Unchanged c024c8b subsequently passed all1221 tests,0failed/skip,66017ms.
This includes the filename search and private upload-status changes preceding
the accessibility fixes. The historical database upgrade suite completed; no
test process was restarted while it was still running. Browser/file-draft recovery
remains explicitly unimplemented and is not covered by that success claim.

Recovery implementation must use a new tab-storage format so older text-only
readers cannot reinterpret file-bearing drafts. Retain bounded file identifiers,
names, sizes, MIME types and known checksums, never raw file contents or tokens.
On restoration, treat every upload as unverified until its owner-only server
status matches. Preserve the entire original pending message payload for unknown
sends. Missing/expired uploads need explicit re-selection, never silent removal
or an automatic text-only send. Opt-in, identity scope,12hour expiry and sign-out
clearing remain part of the existing recovery contract.
