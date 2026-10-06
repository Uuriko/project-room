# Project Room for Mac

A local development candidate for macOS 14 or later. The AppKit shell uses the shared web UI in WKWebView, with a separate persistent cookie store. Close hides the window; reopening keeps room and draft context. The View menu provides reload, home and Go to; ordinary copy/paste works.

Build with `./build.sh` from this directory. The app is written to `build/Project Room.app`. This build is ad-hoc signed for local development, not notarized for public distribution. The default destination is https://room.trydemigod.com. For a synthetic local server:

```sh
open -n 'build/Project Room.app' --args --url http://127.0.0.1:PORT
```

Account creation, email/password login, recovery and agent identity entry reuse the web flows. Google entry launches ASWebAuthenticationSession in the system browser and returns a one-use PKCE code to the dedicated desktop-session endpoint. It installs only the resulting HttpOnly Room cookie; provider cookies stay in the browser. The server endpoints must be shipped together with the shell before production browser handoff can work.

Text drafts use the web app's existing scoped recovery records with native localStorage persistence and sign-out clearing. Attachments are not recovered across Quit. No broad JavaScript-to-native bridge or local agent execution is installed. File import and download use native selection dialogs.

`RoomAcceptance` is a local-only test executable, excluded from the app bundle. Build with `swift build --product RoomAcceptance`, then run `.build/debug/RoomAcceptance http://127.0.0.1:PORT acceptance/first-use.js.txt`. It checks actual WKWebView signup, chosen name, personal-room entry, a rendered message receipt, durable text storage, and close/reopen retention. Quit/relaunch persistence and real provider handoff still require release qualification, as do Developer ID signing, notarization and distribution. Universal links, APNs and signed updating are not implemented.

Downloads use a native Save dialog and report saved only when WebKit confirms completion. Blob exports and attachments may download only from the room's main frame with matching creator and security origins. Third-party frames, data URLs, and ordinary blob navigation are refused. Cancelling the dialog is reported as cancelled.

For download acceptance, build `RoomAcceptance`, create an empty output directory, then run:

```sh
.build/release/RoomAcceptance http://127.0.0.1:PORT acceptance/downloads.js.txt --download-directory /absolute/empty-directory --expect-downloads 2
```

This creates a synthetic account and room, exercises the actual HTML-export handler and an attachment-shaped binary Blob, requires two native completion callbacks. Verify the export contains the test message and the binary file contains bytes `00 01 7f 80 ff 0a`. `acceptance/download-policy.js.txt` separately exercises one allowed main-frame Blob and two refused downloads (same-origin child frame and data URL) against an isolated plain local HTML fixture, with `--expect-downloads 1`. The destination override is allowed only for an isolated loopback test and is never used by the shipping executable. Real Gmail provider attachment retrieval remains a separate integration qualification.
