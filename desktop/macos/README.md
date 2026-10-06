# Project Room for Mac

A local development candidate for macOS 14 or later. The AppKit shell uses the shared web UI in WKWebView, with a separate persistent cookie store. Close hides the window; reopening keeps room and draft context. The View menu provides reload, home and Go to; ordinary copy/paste works.

Build with `./build.sh` from this directory. The app is written to `build/Project Room.app`. This build is ad-hoc signed for local development, not notarized for public distribution. The default destination is https://room.trydemigod.com. For a synthetic local server:

```sh
open -n 'build/Project Room.app' --args --url http://127.0.0.1:PORT
```

Account creation, email/password login, recovery and agent identity entry reuse the web flows. Google entry launches ASWebAuthenticationSession in the system browser and returns a one-use PKCE code to the dedicated desktop-session endpoint. It installs only the resulting HttpOnly Room cookie; provider cookies stay in the browser. The server endpoints must be shipped together with the shell before production browser handoff can work.

Text drafts use the web app's existing scoped recovery records with native localStorage persistence and sign-out clearing. Attachments are not recovered across Quit. No broad JavaScript-to-native bridge or local agent execution is installed. File import and download use native selection dialogs.

`RoomAcceptance` is a local-only test executable, excluded from the app bundle. Build with `swift build --product RoomAcceptance`, then run `.build/debug/RoomAcceptance http://127.0.0.1:PORT acceptance/first-use.js.txt`. It checks actual WKWebView signup, chosen name, personal-room entry, a rendered message receipt, durable text storage, and close/reopen retention. Quit/relaunch persistence and real provider handoff still require release qualification, as do Developer ID signing, notarization and distribution. Universal links, APNs and signed updating are not implemented.
