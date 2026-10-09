## Browser checks N–Z

| Script | One-line purpose | Header? | Possible overlap |
|---|---|---|---|
| native-draft-browser-check.mjs | Native drafts and copied AI returns keep separate private drafts and original basis across reopening; unknown save retains exact input through scope changes and retry. | no | native-result (drafts vs results surfaces) |
| native-result-browser-check.mjs | Uncertain result save resumes exact text; review shows exact text, refuses inconsistent pinned-evidence versions; stale work cannot save without explicit refresh. | no | native-draft; work-changes (stale-draft save mechanics) |
| notification-feed-browser-check.mjs | B4 notification feed: badge, compact list, and "Mark read" moving the cursor; desktop + mobile. | yes | — |
| operator-console-browser-check.mjs | Operator console vs real server with operator secret: status renders, find→plan shows counts, execute gated on typing the room title, token lives only in sessionStorage, axe clean at 390px. | yes | — |
| owner-project-offers-browser-check.mjs | Owner posts, previews, publishes, and withdraws fixed-credit terms without reserving credits; mobile cash draft stays truthful, non-owners have no posting action. | no | project-offers (both cover owner posting of fixed-credit terms) |
| password-reset-browser-check.mjs | Actual reset mail links and fresh sign-in, using local synthetic delivery only. | yes | — |
| people-rail-browser-check.mjs | People rail: presence dots, one-line status, loud @agent handles, Done chips; Done-chip spring is instant under prefers-reduced-motion. | yes | — |
| pinned-messages-browser-check.mjs | Issue #6 B2: member pins from keyboard, Pinned section lists in pin order and follows others' pins live, unpin from the section, deleted message drops out; "Pinned only" search toggle. | yes | — |
| portable-work-browser-check.mjs | Portable work: selected export, copy fallback, stale return, and lost-response retry; desktop + mobile. | no | room-export, receipts (export/document surfaces) |
| project-offers-browser-check.mjs | Public offer journeys at the real Node HTTP/store boundary with no identities enrolled and no external host, mail, funding, or cashout started. | yes | owner-project-offers (owner posting of fixed-credit terms) |
| public-pages-polish-browser-check.mjs | Compare pages and the HTML 404: axe serious/critical at 390 and 1280, no Content-Security-Policy console errors on the compare pages. | yes | — |
| public-work-matching-browser-check.mjs | Owner enable → anonymous suggestions → outside-agent claim; no live services. | yes | public-work-results (two halves of the same public-work pipeline) |
| public-work-results-browser-check.mjs | Real HTTP submission/review and private owner UI for public work results; no live identities or mail. | yes | public-work-matching |
| pwa-browser-check.mjs | Install button and the push soft ask in Chromium; the ask is absent on load and appears only after a needs-you item is handed to the dock. | yes | — |
| qa5-a11y-c-browser-check.mjs | QA5 Slice C: viewer-aware empty-board copy wiring, Note field label-association and note delivery (F-parity-1), malformed-invite boot error screen, 320px overflow, 44px touch targets. | yes | — |
| quiet-attribution-browser-check.mjs | Quiet attribution: short summaries, exact choices, live duplicate names; touch + desktop. | no | quiet-copy (same "quiet" family, different feature) |
| quiet-copy-browser-check.mjs | Quiet copy: account entry is not an error, actual service failure remains visible; minimal sign-in retains keyboard navigation and room state. | no | quiet-attribution |
| receipts-browser-check.mjs | /receipts/<id> at a phone width: the document fits the viewport and exposes main and footer landmarks. | yes | room-export (document/export surfaces) |
| reconnect-collaboration-browser-check.mjs | Reconnect collaboration: simultaneous-attention stable choices with independent resolution; clarify, restart, contribute, and review in crowded and quiet rooms; touch + desktop. | no | reply-request (request/reply workflows) |
| recovery-browser-check.mjs | Actual Node entrypoint pauses without touching populated data, then resumes the same Room in a browser. | no | stream-recovery (resilience: whole-room restart vs EventSource reconnect) |
| refine-draft-browser-check.mjs | Refine draft: separate edits, source link, exact retry and result; desktop + mobile. | no | — |
| reminders-browser-check.mjs | Private reminders: schedule, due clock, privacy, recovery after resolution, keyboard, and reflow; desktop + mobile. | no | — |
| reply-request-browser-check.mjs | Reply-request lifecycle: stale answer keeps text with explicit refresh, lost committed answer stays exact and read-only, unconfirmed receipt locks the request, host progress visible in original conversation. | no | reconnect-collaboration |
| result-copy-browser-check.mjs | Result copy semantics: source changes preserve edits/focus, clipboard refusal preserves editable text, A/B/A edits suppress held feedback, independent Add-result drafts, sign-out/reload clearing. | no | result-diff, room-results (results/copy surface family) |
| result-diff-browser-check.mjs | A late previous-result read cannot repopulate a different review after cancellation. | no | result-copy, room-results |
| room-actions-browser-check.mjs | Room actions menu: intent filtering, keyboard selection, empty state, focus wrapping, shortcuts don't interrupt dialogs, stale-control recheck, reach work/invitation/agent/instructions without creating anything. | no | — |
| room-door-browser-check.mjs | Public /room door: canonical minimal auth, preserved deep links, separate agent packets; touch + desktop. | no | start-room (entry/door auth vs start-a-room flow) |
| room-export-browser-check.mjs | BUILD-01 F2 follow-up: signed-in member takes the readable HTML export from the History panel in room-key mode and account mode (session-bound request a plain link cannot carry). | yes | receipts, portable-work |
| room-instructions-browser-check.mjs | Room charter/instructions: unknown committed charter keeps exact retry through close and updates, non-owner text is selectable, session revocation clears text and ignores late responses. | no | — |
| room-lifecycle-browser-check.mjs | Issue #6 A2: account creates a room from Rooms, opens it, archives it as owner (read-only afterwards), and a member leaves from About and no longer finds it. | yes | — |
| room-overview-browser-check.mjs | Orientation must preserve writing and make no room writes; orientation updates live; mobile + desktop. | yes | work-resume (orientation/next-step without writes) |
| room-policy-browser-check.mjs | Issue #6 A4: when the owner makes review or approval mandatory, the new-work form shows the requirement locked on with the reason, and the recorded item carries it. | yes | — |
| room-results-browser-check.mjs | Results update after review and reopening; read failure preserves the list and allows deliberate retry; late reads after sign-out restore nothing; guests see results with no creation controls. | no | result-copy, result-diff |
| room-trust-browser-check.mjs | Room Trust kill-switch: owner of a cross-owner room flips it — one click off, another click on; synthetic fixture only. | yes | — |
| spend-allowance-browser-check.mjs | Issue #6 C3: owner sets spend allowance from the "Agent spend" card; all members see allowance/spent/reserved/headroom move; owner-only controls; removal restores the default. | yes | — |
| start-room-browser-check.mjs | Start a room: the door's main button opens /?start=room; a new visitor signs in and lands inside their own room, not the Inbox; one-shot intent; setup asks for a name before the room is made. | yes | room-door |
| starter-recipes-browser-check.mjs | H1 recipe strip: catch-up and next-work chips render from committed state; dismissal is local only. | yes | work-recipes (recipe strip/picker) |
| stream-recovery-browser-check.mjs | Native EventSource reconnects after a temporary storage failure without losing identity, unsent draft, or selection. | no | recovery |
| thread-options-browser-check.mjs | Thread-view Mute/Unmute button and "Also send to channel" checkbox on thread replies (hidden for DMs and top-level messages); desktop and narrow. | yes | — |
| updates-browser-check.mjs | Updates HTTP/SQLite journeys: revision-bound marks, exact retries, and retired navigation. | yes | — |
| visual-regression-browser-check.mjs | Q003: screenshot diffs of login/join pages, the signed-in room view, and the #message-list region against committed baselines, with dynamic regions masked. | yes | — |
| work-attempts-browser-check.mjs | Attempt ledger: a work card shows attributable attempts with environment and outcome. | no | — |
| work-changes-browser-check.mjs | F3: a draft based on an older revision gets a "what changed" read-time explanation; a draft at the current revision gets no prompt; neither blocks any action. | yes | native-result (stale-draft mechanics) |
| work-recipes-browser-check.mjs | Recipes: distinct recent definitions prefill a fresh outcome without mutating state; picker stays inside the dialog on mobile. | no | starter-recipes |
| work-resume-browser-check.mjs | Resume handoff: visible next step, opt-in export, no writes; phone + desktop. | no | room-overview |
| work-reuse-browser-check.mjs | Work reuse: known first refusal allows edits, closing an uncertain form is not cancellation, retry rejection unlocks correction without a new work identity, Unicode proposals are correctable. | no | — |
| work-search-browser-check.mjs | Work search returns to outcomes without losing context; search must not submit, acknowledge, or create work. | no | discovery-contribution (imports and re-runs its suite — see notes) |
| workflow-browser-check.mjs | Workflow: lighter checks, exact retries, truthful status, and later findings; desktop + mobile. | no | — |
| signin-browser-journey.mjs | Helper module, not a test file: shared sign-in journey helpers (openMagicSignin, backToPasswordSignin) for reaching magic-link recovery through the visible password-first entry. | yes | — |

### Behavioral notes
- work-search-browser-check.mjs:3 imports `./discovery-contribution-browser-check.mjs`, so executing this file also registers and runs the sibling discovery-contribution suite (its own scope note at line 2: search must not submit, acknowledge, or create work).
- owner-project-offers-browser-check.mjs:55 embeds a pure unit-style assertion of `offerMinorUnits` (exact conversion; rejects '1e3', '-1', '01', '1.0001', '0', 'NaN') inside a browser-check file.
- pwa-browser-check.mjs:6-14 is self-contained: it serves an inline pageHtml via a bare node:http server and imports /src/pwa-install.js directly — no room server; asserts the push soft ask appears only after a needs-you item is handed to the dock.
- stream-recovery-browser-check.mjs:11-15 monkey-patches `f.store.eventsAfter` to throw StorageUnavailableError exactly once, then asserts the native EventSource reconnect preserves identity, unsent draft, and selection.
- visual-regression-browser-check.mjs:1-20 is the Q003 gate: deterministic screenshots at fixed 1280x800 with reduced motion and settled fonts, diffed against committed baselines in scripts/visual-regression-baselines/; dynamic regions (message timestamps, avatars, live presence, invite expiry) are painted over via mask locators before capture.
- signin-browser-journey.mjs:1-16 is a helper module (no tests) exporting openMagicSignin/backToPasswordSignin; consumed at quiet-copy-browser-check.mjs:1 and start-room-browser-check.mjs:1.
- qa5-a11y-c-browser-check.mjs:1-13 is Slice C of the QA5 UI/UX + a11y wave; cites PRs #1456/#1459 and the F-parity-1 regression — the pure functions have their own unit tests; this file guards the render call sites.
- room-export-browser-check.mjs:1-5 is a BUILD-01 F2 follow-up covering account mode, where the export request must carry the session binding that a plain link cannot carry.
- password-reset-browser-check.mjs:1 — exercises actual reset mail links and fresh sign-in via local synthetic delivery only.
- pinned-messages-browser-check.mjs:2-8 — Issue #6 B2 pin flow plus "Backlog follow-up 8": the "Pinned only" search toggle narrows by typed term, follows unpin live, and clears with the search.
- Issue #6 traceability: room-lifecycle (A2) at room-lifecycle-browser-check.mjs:3-7, room-policy (A4) at room-policy-browser-check.mjs:3-5, spend-allowance (C3) at spend-allowance-browser-check.mjs:3-5, notification-feed (B4) at notification-feed-browser-check.mjs:2, pinned-messages (B2) at pinned-messages-browser-check.mjs:2-8.
- refine-draft-browser-check.mjs:12-13 drives the check through startHelperAgentExercise from ./helper-agent-exercise.mjs (a full helper-agent exercise, not just the fixture store).

DONE: 49 scripts, 0 stale flags, 0 suspected bugs
