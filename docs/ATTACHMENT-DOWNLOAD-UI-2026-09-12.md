# Download interface checkpoint

Committed files now appear directly beneath their message as filename-and-size
buttons. Accessible labels identify the download; while a transfer runs, the same
control offers Cancel. No preview embeds uploaded HTML or other active content.

The button uses the verified client, then rechecks identity, room generation,
message existence/deletion and the current file checksum before creating a save
link. Blob URLs are revoked after dispatch. Message rerenders retain the focused
file's identity even when a message has several attachments.

## Evidence

- Two real Chromium journeys passed at1360×900 desktop and390×844 touch/mobile
  emulation. Each signed in, downloaded a committed file, verified its Unicode
  filename and exact saved bytes, then cancelled a held second transfer.
- Buttons fit both viewports and have at least44px height. Both screenshots were
  visually inspected: filename/size controls fit under the message without
  horizontal clipping. No browser runtime errors occurred.
-39 focused client/conversation tests passed; whitespace verification passed.

This is synthetic browser evidence, not physical-device or human usability proof.
Uploads are still API-only: composer file selection/progress/retry and file-only
messages remain required. Full regression for the combined client/UI checkpoint
is still outstanding. Grok G7 independently reviews unchanged HTTP02fba88.
No deployment or canonical source edits occurred.
