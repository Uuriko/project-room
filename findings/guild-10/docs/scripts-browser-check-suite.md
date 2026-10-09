# The *-browser-check.mjs suite

_Guild-10 doc-coverage page (wave1000). Generated 2026-10-09 from module header comments,
export lists, and `git grep` caller evidence. Each module below had no dedicated doc page.
Purpose/invariants/gotchas are quoted from the module's own header comment where present._

## `scripts/a11y-composer-browser-check.mjs`  (56 lines)

**Purpose.** Q011: axe-core sweep of the message composer. Signs in and opens the composer options disclosure, then runs axe scoped to the composer region (#message-form and the open #composer-options). Scoping keeps this check's contract on the composer alone: the rest of the page is owned by the room-view sweep. Fails on any serious or critical axe violation (wcag2a/2aa/21a/21aa/22aa).

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/a11y-login-browser-check.mjs`  (73 lines)

**Purpose.** Q011: axe-core sweep of the login/join entry points. Covers the two unauthenticated entry flows a new user or agent meets: 1. the signed-out room page (the login/auth panel on index.html) 2. the agent join page (join.html): consent form with a live invite code, and the error state for a bogus code Both viewports a real visitor uses: desktop 1280 and mobile 390. Fails on any serious or critical axe violation (wcag2a/2aa/21a/21aa/22aa).

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/a11y-room-browser-check.mjs`  (60 lines)

**Purpose.** Q011: axe-core sweep of the signed-in room view. The main room UI after authentication: message list (seeded with one message so list markup is exercised), member chrome, and dialogs closed. Both viewports. Fails on any serious or critical axe violation (wcag2a/2aa/21a/21aa/22aa).

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/account-deletion-browser-check.mjs`  (97 lines)

**Purpose.** QA2 finding P2-11: Settings → Sign-in & security → Advanced offers Delete account. The dialog shows the plan, requires the account email, and posts the confirmation token with the session CSRF header.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/account-settings-browser-check.mjs`  (242 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/acquisition-browser-check.mjs`  (42 lines)

**Purpose.** Templates, a template page, a public room page, and the agent directory at a phone width: each document fits 390px and exposes main and footer.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/action-dialog-focus-scroll-browser-check.mjs`  (92 lines)

**Purpose.** NR-B: the action dialog's async exact-text load must not leave the focused review-notes textarea clipped by the dialog's bottom edge at 320x900. Regression: without the post-load focus re-assert in loadActionText, a slow exact-text response shifts layout after the browser's focus scroll already ran, and the textarea (plus its focus outline) ends up below the visible edge of the dialog.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/action-recovery-browser-check.mjs`  (408 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/activity-feed-browser-check.mjs`  (191 lines)

**Purpose.** Attention: Activity feed, Later (saved messages), Mark unread, and the read-horizon "New messages" divider. Real browser + local HTTP service; all identities, messages, and keys are disposable fixtures.

## `scripts/agent-signin-browser-check.mjs`  (226 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`, `scripts/secret-scan-check.mjs`

## `scripts/agent-work-access-browser-check.mjs`  (74 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/auth-return-browser-check.mjs`  (188 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/board-browser-check.mjs`  (1100 lines)

**Purpose.** Tasks › Board: claim actions, linked work and return journeys, 390px, and axe. The room page and the work-claim HTTP API are the boundary. No test doubles.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`, `tests/quarantine.json`

## `scripts/chat-suggestions-browser-check.mjs`  (90 lines)

**Purpose.** Chat suggestions above the composer: an agent's "short or detailed?" offers one-tap replies, and a tap sends that reply as an ordinary message; a request that reads like work offers "Make this a task", which opens the work form from that message. Real browser + local HTTP service.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/claim-overlap-browser-check.mjs`  (47 lines)

**Purpose.** Claim overlaps on the work card: when a claim covers paths another active claim in the same repository already holds, the card's scope summary says "Overlaps 1" and the details name the other work, its holder and the paths. Real browser + local HTTP service; disposable fixture data.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/decision-register-browser-check.mjs`  (82 lines)

**Purpose.** Decision register (backlog F2) browser check: a human with decide promotes a message into a source-backed decision record; members without decide get no such affordance. Disposable rooms only - no real users or outside requests.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/deleted-message-browser-check.mjs`  (90 lines)

**Purpose.** Deleted-message rendering (wave finding fix): message.deleted tombstones the projection (body=null, deletedAt). Rendering must honor the tombstone - no null-body crashes in reply previews, search, request or decision labels, and no body-dependent actions on a deleted message. Disposable rooms only.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/design-cohesion-browser-check.mjs`  (240 lines)

**Purpose.** Computed-style regression for the shared tokens and the regrouped Settings dialog. The repo has no pixel-snapshot library; screenshots are evidence and these assertions are the check.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/desktop-google-browser-check.mjs`  (242 lines)

**Purpose.** Owns real desktop consent through Google's cross-origin browser return. Provider authorization/token/JWKS are synthetic; every Room route and cookie is real.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/dm-consent-browser-check.mjs`  (208 lines)

**Purpose.** DM consent UI journey under default-open DMs: request → pending (never gates the composer) → approve → DM posts → revoke → the gate refuses the DM and names the next step → block → gate errors → unblock, plus a forced 500's visible notice and the logged-out public face staying consent-control-free. Real browser + local HTTP service; identities and keys are disposable fixtures.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/dogfood-return-browser-check.mjs`  (46 lines)

**Purpose.** Synthetic browser journeys in disposable rooms; no real users or external data.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/friend-bond-browser-check.mjs`  (275 lines)

**Purpose.** People Friend chrome: Friend → Proposed → Accept → Friends + peer DM → Revoke. A peer DM before the bond is active fails with no_bond, then bond_pending. No scopes picker. Real browser + local HTTP service; disposable identities.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/gmail-setup-browser-check.mjs`  (103 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/gmail-workspace-browser-check.mjs`  (98 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/growth-invite-browser-check.mjs`  (76 lines)

**Purpose.** Invite kit in a real browser: one Invite entry, a copyable link and message, a landing that names the inviter, and a dead link that still offers a next step.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/help-invitation-browser-check.mjs`  (216 lines)

**Purpose.** global document -- browser-evaluated callbacks */

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/help-offer-browser-check.mjs`  (206 lines)

**Purpose.** Simulated humans and scripted MCP over a disposable local room. No model use.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/human-experience-browser-check.mjs`  (381 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/human-push-browser-check.mjs`  (109 lines)

**Purpose.** Human push is one button behind the browser permission prompt. The settings dialog stays free of notification levels and quiet hours.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`, `scripts/secret-scan-check.mjs`

## `scripts/inbox-browser-check.mjs`  (1499 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`, `tests/quarantine.json`, `tests/report-test-failures.test.js`

## `scripts/inbox-conversation-browser-check.mjs`  (111 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/join-next-browser-check.mjs`  (71 lines)

**Purpose.** The join page follows next only when it is one relative path on this origin.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/layout-simplification-browser-check.mjs`  (95 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/lazy-boards-browser-check.mjs`  (115 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/live-upgrade-draft-browser-check.mjs`  (74 lines)

**Purpose.** Exact pre-release live client -> candidate upgrade; disposable local data only.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/loop-warning-browser-check.mjs`  (66 lines)

**Purpose.** Simulated human journeys in real browsers against isolated, synthetic rooms.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/member-perms-browser-check.mjs`  (397 lines)

**Purpose.** MEMBER-PERMS PR2: simulated browser journeys against a disposable real server. Authoring gate: these own UI wiring, selection, retry and session lifecycle. Credible regressions are posting admission instead of an authenticated upgrade, sending unselected grants, duplicating a committed request after response loss, or painting the previous member's callback into a new session. HTTP tests do not mount the UI; these use no production test seams or fabricated API replies. The two happy-path viewports additionally guard mobile reachability and native keyboard activation; Escape review dismissal must restore the initiating focus. Additional regressions own prelookup-throttle retry continuity, live ownership loss with an open review, and keyboard focus across real stream-driven refreshes.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/message-preview-browser-check.mjs`  (78 lines)

**Purpose.** Authoring gate: real Chromium owns disclosure accessibility and retained DOM during streamed updates. Markdown tests cannot detect paragraph reparsing, lost selection/focus, duplicate visible text or theme/mobile layout failures. Regression control: baseline has no expandable preview. No production hooks.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/native-draft-browser-check.mjs`  (217 lines)

**Purpose.** Scripted people and MCP reviewer, isolated local data. No model or provider use.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/native-result-browser-check.mjs`  (297 lines)

**Purpose.** Simulated human interaction in disposable local rooms, never a user study.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/oauth-return-invite-browser-check.mjs`  (99 lines)

**Purpose.** A returning member who opens a friend's link and signs in with Google must land on that invitation, not in their own first room. The Google callback sends anyone who already has a room to /?room=<first room>, and the OAuth stash restore used to refuse any ?room= landing, so the friend's link was dropped for every returning member. Provider endpoints are synthetic; every Room route, cookie and the share link are real.

## `scripts/operator-console-browser-check.mjs`  (135 lines)

**Purpose.** Operator console (operator.html) against a real server with the operator secret configured: status renders, find -> plan shows counts, execute stays disabled until the room title is typed, the purge runs, and the token lives only in sessionStorage. axe reports no serious or critical issue at 390 px.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/owner-project-offers-browser-check.mjs`  (78 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/portable-work-browser-check.mjs`  (212 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/project-offers-browser-check.mjs`  (159 lines)

**Purpose.** Public offer journeys against the real Node HTTP/store boundary; no identities are enrolled and no external host, mail, funding or cashout is started.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/public-pages-polish-browser-check.mjs`  (146 lines)

**Purpose.** Compare pages and the HTML 404: axe serious/critical at 390 and 1280, and no Content-Security-Policy console errors on the compare pages.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/public-work-matching-browser-check.mjs`  (213 lines)

**Purpose.** Actual owner enable → anonymous suggestions → outside-agent claim. No live services.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/public-work-results-browser-check.mjs`  (193 lines)

**Purpose.** Real HTTP submission/review and private owner UI; no live identities or mail.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/pwa-browser-check.mjs`  (84 lines)

**Purpose.** Install button and the push soft ask, in Chromium. The ask is absent on load and appears only after a needs-you item is handed to the dock.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`, `tests/pwa-install.test.js`

## `scripts/qa5-a11y-c-browser-check.mjs`  (154 lines)

**Purpose.** Slice C (QA5 UI/UX + a11y): user-testing for the newly merged UI work. Covers the render paths the unit tests don't reach: - S1 (#1456): the viewer-aware empty-board copy is wired through boardHtml (the pure emptyBoardCopy function has its own unit test; this guards the call site that passes canWrite/signedIn). - S3 (#1456): the New-item form's Note field is label-associated and the note reaches the created claim end to end (the F-parity-1 regression). - D-c (#1459): the client-side boot() fail path shows the error screen with the back-to-sign-in fallback for a malformed invite code. - 320px viewport: no horizontal overflow on the main page or board dialog. - Coarse pointers: the 44px touch-target floor holds on board controls. Real browser + disposable loopback server; no external identity.

## `scripts/quiet-attribution-browser-check.mjs`  (81 lines)

**Purpose.** Simulated local readers, not human research or identity verification.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/quiet-copy-browser-check.mjs`  (116 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/receipts-browser-check.mjs`  (45 lines)

**Purpose.** receipts/<id> at a phone width: the document fits the viewport and exposes main and footer landmarks.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/refine-draft-browser-check.mjs`  (100 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`

## `scripts/reminders-browser-check.mjs`  (111 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/reply-request-browser-check.mjs`  (240 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/result-copy-browser-check.mjs`  (215 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`, `scripts/secret-scan-check.mjs`

## `scripts/room-instructions-browser-check.mjs`  (116 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/room-overview-browser-check.mjs`  (79 lines)

**Purpose.** Synthetic room only: orientation must preserve writing and make no room writes.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/start-room-browser-check.mjs`  (71 lines)

_No header comment — purpose inferred from exports below._

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/thread-options-browser-check.mjs`  (100 lines)

**Purpose.** Browser check for the two thread-options features, desktop and narrow: the thread-view Mute/Unmute button and the "Also send to channel" checkbox on thread replies (hidden for DMs and top-level messages).

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/updates-browser-check.mjs`  (1528 lines)

**Purpose.** Updates HTTP/SQLite journeys: revision-bound marks, exact retries and retired navigation.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/visual-regression-browser-check.mjs`  (225 lines)

**Purpose.** Q003: visual regression (screenshot diff) tests for the key UI pages. Covers the three surfaces a visitor or member actually sees: 1. login/join entry pages — signed-out auth panel, join consent form (live invite), join error state (bogus code) 2. signed-in room view — member chrome plus a seeded message list 3. message list region — the `#message-list` element on its own, so a message-markup regression cannot hide behind chrome pixels Each test captures a deterministic screenshot (fixed 1280x800 viewport, reduced motion, fonts settled, seeded store data) and diffs it against a committed baseline in scripts/visual-regression-baselines/. Dynamic regions — message timestamps, avatars, live presence, invite expiry — are painted over via mask locators before capture (baselines carry the same masks), so the gate only sees intentional visual changes. A fourth test is the failing-first proof: i

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/work-attempts-browser-check.mjs`  (51 lines)

**Purpose.** Simulated human journeys against disposable first-party data, not human research.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/work-changes-browser-check.mjs`  (62 lines)

**Purpose.** Simulated human journeys in real browsers against isolated, synthetic rooms.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`

## `scripts/work-resume-browser-check.mjs`  (63 lines)

**Purpose.** Synthetic restart journey in a real browser; no real user data or agents.

**Callers/importers (git grep HEAD):** `package.json`, `scripts/browser-ci-durations.json`
