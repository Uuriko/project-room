# Enter a room and start collaborating

Status: implementation in progress. Source: John's 14-screen desktop/entry audit, 19 October 2026. Preferred layout: Focused task.

## Outcome
A person or agent can enter the right room, understand who they are connected as, and start collaborating without managing authentication machinery. Conversation remains the main surface. Existing authorization, recovery, invitation expiry, session fencing and private-room boundaries remain authoritative.

## Delivery sequence

1. Repair entry dead ends. Make invitation loading, unavailable, expired, unverified and failed states visible. Do not leave empty fields with unexplained disabled actions. Clear stale links on reopen and ignore replies from an old room/session. Load Account from both its disclosure and its menu action; focus the destination after mounting.
2. Simplify room choice. Put room search, Join room and New room ahead of ancillary information. Use one room navigation action. Search authorized room rows without inventing public discovery. Preserve pagination and distinguish no memberships from no matching rows. Keep actionable owner decisions accessible, but move them after the room list and suppress empty summaries. Preserve deep links and returning-room behavior.
3. Simplify human entry. Replace the implicit blank-password convention with explicit email continuation/password choices. Only show configured providers. Carry invitation/room context through verification and OAuth. Preserve account creation terms, password recovery, guest upgrades, and linked-identity protection. Do not automatically create duplicate accounts.
4. Unify agent connection. Audit and reuse the existing guided join operation before adding APIs. Resolve saved identity, preview room/scope, join idempotently, persist credentials safely, and confirm access. Missing identity, expired invitation, permission failure, interrupted join, and missing persistent storage must return useful structured states. Membership is not evidence of a running listener. Put manual secret entry behind an advanced route and fix creation-mode copy.
5. Clean conversation controls. Replace the large ambiguous disconnected card with compact assistant-specific status. Expose attachment directly. Keep one Send action and explain special routing only when selected. Remove one-item Invite disclosures and redundant navigation; preserve explicit shared asks and consequential approval controls.
6. Qualify and deliver. Add regression coverage for observed failures rather than snapshotting copy alone. Exercise owner/member/guest, invitation-present/absent, empty/error/loading, keyboard, narrow/short windows, and both themes. Save after screenshots. Run affected checks, lint, full suite and relevant browser journeys. Report unrelated failures honestly. Publish reviewable commits/PRs; coordinate merge/deploy separately and independently verify production before claiming shipped.

## Design acceptance
- One room chooser with a visible join action; no empty attention dashboard before rooms.
- Invitation dialog always has a usable link or an explanation and next action.
- Every Account entry mounts the same content and focuses the relevant heading.
- Provider state agrees between entry and account settings.
- Room connection and assistant availability use distinct labels.
- Agent setup reuses identity and never prints secrets or claims unsupported listening.
- Existing private-room rules and request/approval paths remain intact.

## Evidence and open dependencies
- Local viewport commit 729bf904 is not deployed; include its fix after review.
- Its full suite completed with 11,365 passes and one receipt PNG byte-identity failure (platform-sensitive hypothesis, not confirmed baseline); preserve the output at /tmp/room-viewport-tests.log.
- Real-human usability, physical-device verification and provider completion remain separate qualification work. No new accounts or live permissions are needed for disposable fixture tests.
- Implementation should update this document with actual completion and exact checks, not turn intentions into claims.

## Implementation checkpoint — 19 October

Implemented visible invitation loading/error/retry and role-aware unavailable states, stale-response fencing, inactive-link copy prevention, optional invitation message disclosure, and reusable agent-instruction copying. Both Account entry points now mount settings with per-session deduplication and session reset. Rooms navigation opens one searchable authorized-room list with Join room; redundant Switch room stays hidden. Empty owner summaries and invitation rewards are suppressed. Provider availability now reaches standalone sign-in navigation; settings distinguish connected providers. Email-link login is explicit, including when a password was filled. Attachment is directly accessible in the composer; assistant status is compact and named; the short-window viewport repair and regression are included.

The existing resumable agent connection operation was retained rather than duplicated. Its identity reuse and scope tests passed (20/20). Human authentication/account targeted tests passed (60/60); sign-in tests passed (33/33). The affected suite passed 2,156 with one skip before the final small refinements. Browser entry/provider checks passed at 1280 and 390 pixels, and layout passed six cases including 758×470. Invitation-copy and composer browser checks also passed. Lint has zero errors and 291 existing warnings. The new browser suite is registered in the disk-derived CI list with an explicitly local measured duration.

Full-suite qualification is not yet green: the initial run caught missing browser registration (repaired), three i18n harness assertions involving HEAD-relative counts, and the receipt PNG hash failure. The PNG failure independently reproduces on the unchanged base checkout; no expected hash or baseline was relaxed. Final receipts must accompany review; earlier passing evidence does not certify later source changes.

Remaining product scope: a fully unified email-first signup flow, a simpler New room form, account settings information architecture, owner-notice noise, and a complete focused-task pane redesign. These are not represented as finished. Local Chromium fixture screenshots do not qualify native WebKit, real OAuth, physical phones or real-human productivity. This branch is not deployed.

### Final focused receipts
After committing the reduced string surface, the HEAD-relative i18n harness and browser-registration tests pass 25/25. Their earlier failures came from the uncommitted comparison state; no harness or baseline changes were made. The final role-aware invitation browser checks pass 2/2; layout passes 6/6 including the short-window case. Durable local screenshot review: `/Users/johnpotter/Documents/ChatGPT/project room/outputs/entry-simplification-20261019/index.html` (local artifact, not published).
