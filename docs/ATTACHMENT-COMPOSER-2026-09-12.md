# Composer file-sharing checkpoint

The composer now exposes a compact Attach files button and native file picker.
Up to4 files of1MiB each upload sequentially per selection. Each file shows its
name and Waiting/Uploading/Ready status, with Cancel, Retry or Remove as applicable.
The server remains authoritative for quotas and concurrent admission.

Selections live on their conversation draft, not a global room buffer. Upload
completion updates the captured draft. A new session discards those drafts and
aborts active transfers. Sending refuses unfinished files, then commits verified
upload IDs with the message. A pending file-bearing send reuses its exact payload;
its files cannot be silently changed on retry. Successful sends clear only their
own draft, not whichever thread the user navigated to meanwhile.

Removal attempts private staging cleanup. If cleanup cannot be confirmed, server
expiry is the fallback; no claim is made that cancelling a network request undoes
an already-completed staging write. Committed file deletion still belongs to the
revision-checked message deletion path.

## Evidence

-25 focused draft/conversation/reply tests passed, including new thread ownership
  and file-bearing recovery exclusion checks.
- Two Chromium desktop/mobile journeys passed: byte-exact download/cancel plus
  native picker upload, explicit captioned send, committed file verification,
  simulated lost upload response, idempotent retry and staged-byte removal.
- Earlier20 focused upload/conversation checks passed. This did not include a
  draft-recovery suite: the initially supplied draft-recovery filename did not
  exist; the25-test follow-up uses actual draft-return/reply-composer suites.
- No browser runtime errors. Full combined regression remains pending.

## Remaining requirements and limits

Caption text is still required in schema29. File-only messages need compatible
event/recovery qualification before removing this requirement. Uploads are not
available in specialized reply-request modes yet. Refreshing clears file-bearing
drafts, including caption text; the interface says so. Tab recovery deliberately
excludes these drafts rather than silently restoring a text-only send or replaying
unknown commits without their file identities. Durable file-draft recovery remains
required for the polished product.

Progress is qualitative, not a fabricated percentage. Broader multi-selection,
thread-switch, pending-send resolution, keyboard focus, signout, timeout and
physical-device qualification remain open. G7's HTTP review remains separate.
No deployment, external storage service or canonical source edits occurred.
