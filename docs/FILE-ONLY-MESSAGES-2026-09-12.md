# File-only messages

Users can now select a file and send without inventing caption text. The composer
requires text only when there are no ready files or when using a specialized
reply-request mode. Empty messages without files and whitespace-only text remain
invalid. Downloads use the existing verified, non-inline path.

## Compatibility

Schema30 changes the writer/replay contract, not the attachment table layout.
Older writers are fenced out because their event validation rejects empty bodies.
The version29 writer function is retained for historical migration guards; new
writes use version30. Existing events remain unchanged. Runtime packaging accepts
the new version. Current-schema test expectations moved to30; the deliberately
unsupported future database fixture moved to31.

Envelope validation permits exactly empty message text only with an attachment
array. Full post validation and the attachment audit still validate metadata,
ownership and bytes. The independent reply-history audit was updated to recognize
ordinary file-only posts; specialized reply requests still require text.

## Evidence

-48 focused attachment, writer-fence, provenance and conversation tests passed.
  New coverage verifies file-only posting, exact retry, room-visible bytes,
  recovery replay and rejection of an empty fileless message.
- Genuine29→30 migration passed in Node and Worker, including rollback, historical
  data preservation, old-writer rejection and Worker restart. Historical baseline
  is a008732e5a514699bd07114ffb8cf5f53047f0cd.
- Real Worker HTTP round trip with a file-only message passed.
- Two desktop/mobile Chromium journeys passed, now including file-only send in
  addition to captioned upload, lost-response retries, download/cancel and removal.
- An initial browser run failed against the old validation path. The generic
  envelope and independent reply-history checks were then corrected; the fresh
  run passed. No failed run is represented as evidence of success.

Exactdb87e06 full regression passed1217/1217,0failed/skip,31591ms. Physical-device
validation, durable file-draft recovery, specialized request attachment support,
filename search, larger-file policy and public/agent contract updates remain open.
No deploy or canonical source edits occurred.

## Filename search follow-up

Browser and service searches now match committed attachment filenames literally,
case-insensitively, within the authenticated room. File-only browser result rows
show filenames instead of an empty excerpt. Service results include file metadata,
not stored bytes. Browser search now explicitly excludes deleted/null-body messages
instead of trying to search tombstones as text. No file content indexing was added.

16 focused search/conversation tests passed, including staging exclusion,
cross-room refusal, literal bracket matching, read-only behavior and deleted-file
exclusion. Two desktop/mobile browser journeys also passed with a visible filename
search result after sending a file-only message. These later search changes have
not yet received the complete regression gate.
