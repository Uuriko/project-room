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
