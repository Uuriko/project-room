# Project Room for Mac

A local development candidate for macOS 14 or later. The native AppKit app combines the shared conversation UI in WKWebView, a separate persistent cookie store and a native local tool broker. Close hides the window; reopening keeps room and draft context. The View menu provides reload, home and Go to; ordinary copy/paste works.

Build with `./build.sh` from this directory. The app is written to `build/Project Room.app`. This build is ad-hoc signed for local development, not notarized for public distribution. The default destination is https://room.trydemigod.com. For a synthetic local server:

```sh
open -n 'build/Project Room.app' --args --url http://127.0.0.1:PORT
```

Account creation, email/password login, recovery and agent identity entry reuse the web flows. Google entry launches ASWebAuthenticationSession in the system browser and returns a one-use PKCE code to the dedicated desktop-session endpoint. It installs only the resulting HttpOnly Room cookie; provider cookies stay in the browser. The server endpoints must be shipped together with the shell before production browser handoff can work.

Text drafts use the web app's existing scoped recovery records with native localStorage persistence and sign-out clearing. Attachments are not recovered across Quit. No JavaScript-to-native execution bridge is installed. Native local tool execution is described below. File import and download use native selection dialogs.

`RoomAcceptance` is a local-only test executable, excluded from the app bundle. Build with `swift build --product RoomAcceptance`, then run `.build/debug/RoomAcceptance http://127.0.0.1:PORT acceptance/first-use.js.txt`. It checks actual WKWebView signup, chosen name, personal-room entry, a rendered message receipt, durable text storage, and close/reopen retention. Quit/relaunch persistence and real provider handoff still require release qualification, as do Developer ID signing, notarization and distribution. Universal links, APNs and signed updating are not implemented.

Downloads use a native Save dialog and report saved only when WebKit confirms completion. Blob exports and attachments may download only from the room's main frame with matching creator and security origins. Third-party frames, data URLs, and ordinary blob navigation are refused. Cancelling the dialog is reported as cancelled.

For download acceptance, build `RoomAcceptance`, create an empty output directory, then run:

```sh
.build/release/RoomAcceptance http://127.0.0.1:PORT acceptance/downloads.js.txt --download-directory /absolute/empty-directory --expect-downloads 2
```

This creates a synthetic account and room, exercises the actual HTML-export handler and an attachment-shaped binary Blob, requires two native completion callbacks. Verify the export contains the test message and the binary file contains bytes `00 01 7f 80 ff 0a`. `acceptance/download-policy.js.txt` separately exercises one allowed main-frame Blob and two refused downloads (same-origin child frame and data URL) against an isolated plain local HTML fixture, with `--expect-downloads 1`. The destination override is allowed only for an isolated loopback test and is never used by the shipping executable. Real Gmail provider attachment retrieval remains a separate integration qualification.

## Native local tools

The Mac app now owns a native local tool broker. Open **My Mac** in the toolbar or
View menu (⌘,). Its initial state is paused. **Enable local tools** grants broad
file/process authority to local agents for this app session; **Pause all local tools**
refuses new operations and kills running process groups. Closing the Room window keeps
the app and broker running; Quit stops them. Relaunch requires fresh enablement.

**Copy agent connection** copies an MCP configuration pointing to the bundled
`Contents/MacOS/ProjectRoomTools` executable. Add it to your local agent's MCP settings.
The app must stay running. Discovery works without computer permission; execution needs
native enablement and whichever access macOS permits. The adapter does not start models.

Tools: `mac_status`, `mac_files_read`, `mac_files_write`, `mac_process_run`, and
`mac_process_cancel`. File reads/writes support up to 64KiB of UTF-8. Writes require a
previous SHA256 or `expectedAbsent: true`; the check serializes this broker's writers but
is not a filesystem transaction against unrelated programs. Process calls take an
absolute executable, literal argument array, working directory and 100–300,000ms timeout.
They run as the logged-in owner with network access and broad user authority; choosing
`/bin/sh` explicitly enables scripts. Returned combined output is capped at 64KiB.
Ambient API-key environment variables are not inherited. This is not a process sandbox.

For every mutation preserve its request ID and exact arguments. The private journal is
synchronized before execution. Completed retries return the recorded result; a crash
leaving a prepared operation refuses automatic re-execution. Reconcile the actual effect
before deciding what to do next. Cancellation first requests stop; the original process
result records the observed outcome. Do not turn a reported success into room approval.

The local Unix socket has an owner-only directory and socket, peer-UID validation and a
random nonce in a mode-0600 connection file. No TCP port or JavaScript/native execution
bridge is installed. Any trusted local agent with this connection receives the enabled
owner authority. Local private results are not automatically posted to a room.
Web/shared-room device enrollment, account-specific delegation, durable grants, live
model integration, native app/screen action tools and cloud-account connectors remain
separate delivery work. The pane reports actual Accessibility/Screen permission checks;
Full Disk Access is manual and Automation requires approval per target app.

Native acceptance uses temporary files and real processes only:

```sh
swift build --product ProjectRoomTools
swift run LocalToolsAcceptance
```

This covers grant/revision refusal, file versions, exact retry and restart, observed exit,
unknown-outcome reconciliation, timeout/pause/cancel, returned-output limits, actual stdio
MCP to the socket/broker/process, nonce rejection, private connection permissions and
revocation. It does not grant this app OS privacy permissions. `swift test` needs XCTest,
which is absent from this Mac's Command Line Tools; the standalone executable runs the
same production broker code without an XCTest dependency and is excluded from the app.

### Native browser authentication acceptance

Build `swift build -c release --product NativeAuthAcceptance` in `desktop/macos`, then run `node desktop/macos/auth-lifecycle-acceptance.mjs` from the repository root on macOS with Playwright Chromium installed. This isolated loopback owner activates the actual WK Google sign-in link, races a menu action, checks cancellation/startup failure/stale callbacks, and drives real Room Google callback/consent/PKCE redemption through to an authenticated WK account-session readback with an HttpOnly cookie. Only the external provider and ASWebAuthenticationSession UI are synthetic; no personal browser cookies or provider account are used. The acceptance executable is excluded from the app bundle; an injected authentication factory is permitted only in isolated loopback instances. Actual Google account/browser integration and Developer ID/notarization remain separate release qualifications.
