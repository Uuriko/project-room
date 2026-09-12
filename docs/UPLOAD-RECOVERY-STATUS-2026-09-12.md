# Upload status for draft recovery

GET/HEAD `/api/rooms/:roomId/attachments/:id/status` now returns an owner-only
metadata receipt. Normal room authentication, session binding and read limits
apply. Other members receive404 even when they may download the committed file.
The response never includes raw bytes and is not publicly cached.

The receipt distinguishes staged, committed, deleted, discarded and expired state,
and includes the associated message ID when one exists. Ready staged bytes are
verified by length/checksum; committed files also pass existing message linkage
and content verification. Expired/discarded/deleted states do not claim their
absent payloads can be verified. Reading status never extends expiry or mutates
storage. Unsupported write methods return405.

24 focused Node checks passed, covering private metadata, all lifecycle states,
HEAD, no mutation, corrupt-byte refusal and existing upload/message boundaries.
The real Worker HTTP check also passed for staged and committed status with a
1MiB file. Full combined regression remains outstanding.

This endpoint is the server prerequisite, not completed browser recovery. Next:
retain bounded identifiers and metadata only with the existing Remember drafts
opt-in; revalidate ownership/status before restoring readiness; preserve exact
pending command identity; require re-selection for unuploaded/expired files.
Never turn an unknown file-bearing send into a fresh text-only message.

G8 review was read in full. Accepted follow-ups: display upload errors, preserve
composer file-action focus, name controls by filename, and restore file drafts.
Its blanket download-focus claim is unproven: renderMessages already restores
focus using file ID as well as message action. Test that separately before changing
it. No deployment or canonical source edits occurred.
