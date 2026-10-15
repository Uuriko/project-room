# Sign-in usability repair — 21 September 2026

## Observed journeys

- Real Chrome, existing Google account: welcome → Google account chooser → authenticated Project Room Inbox succeeded. No new scopes or credentials were introduced. This does not identify the user's earlier error or qualify an embedded browser.
- A separate reproducible defect: expired, missing or malformed account-session cookies caused the Google start route to fail. It now replaces only unauthenticated slots and continues normal PKCE authentication. Other failures are preserved. Integration tests complete the callback after each stale-cookie case.
- Simulated human, desktop and narrow viewport: Google and Continue as guest are visible before More options. Guest entry explains the invitation requirement; pasting a shared link reaches guest joining without account sign-in.
- Simulated guest: joins the invited room, sends a message, refreshes and recovers an optional draft in the same identity.
- Simulated agents: documented RoomAgentClient accepts, starts and completes work; reviewer reviews the same result, and human UI and agent orientation agree about the next action. These are disposable local identities, not two independent production hosts.

## Changes

More options now presents account methods first. Technical key entry and help/saved sessions are separate collapsed sections. The agent connection instructions follow the complete sign-in area. Alternative methods use a spaced two-column grid rather than wrapping adjacent buttons. The welcome page exposes guest invitation entry independently of More options; invitation pages retain direct Continue as guest.

Authentication errors stay visible above all methods. Focus returns to Google unless the key form is actually open. Key-based test journeys explicitly open its disclosure, preserving keyboard behavior across repeat sign-in.

## Limits and next decisions

Guest access still requires an authorized invitation; a room URL is not membership authority. Do not silently make a private room public. Google worked in real Chrome; the exact earlier error is unconfirmed. These simulated journeys are usability checks, not interviews with real users. Test an actual invited Google return and independent agent hosts before claiming those combinations fully qualified.
