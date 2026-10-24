# Project Room: conversation-first workspace audit

Status: implementation in progress, not released. This audit combines source inspection of the application shell with scripted browser journeys and native WKWebView acceptance. It is not a claim that every device, account state, or person has been tested. The existing release acceptance and collaboration plans remain in force.

## Product decision

Make conversation the place people start, follow work, and respond. Open an adjacent preview only when the material benefits from its own reading space. Keep the workspace stable as work progresses. Codex is a reference for restraint and contextual tools, not a reason to erase multiplayer identity, audience, or approval boundaries.

The test for every visible control is: what user action does it enable here, how often is it needed, and can the existing conversation or a contextual action do the same job? Hide rare actions behind one understandable menu. Delete duplicate routes before adding a new navigation category. An icon without a clear accessible name is not simplification.

## Current implementation slice

- Remove the Results settings modal and separate sidebar destination. Existing results links use the existing search area; the agent results API is unchanged.
- An ordinary short result opens its authorized source message. The initial rule is deterministic (at most 1,200 characters, exact current message body, not withdrawn); saved historical selections retain exact-version recovery. Validate this rule against real material before expanding it into content classification.
- A substantial result opens a right-hand preview at 340 CSS pixels, with draggable and keyboard-operable divider. Minimum 280; maximum preserves 420 pixels for conversation and the sidebar. Remember the preferred width without caching private result text.
- Keep title, close, and one overflow menu in the preview header. Move Copy, Download, and Original into that menu; keep Reply directly available. Do not show a second page of task administration while reading.
- On narrow windows, use the available width and an explicit Back to conversation. Preserve the draft; do not put a dimmed modal over it.
- Display member names instead of raw member identifiers. Retain exact version and withdrawal information.
- Retain all uncertainty, authority and privacy checks. Successful-looking UI is not evidence that a command succeeded.

## Surface-by-surface decisions

| Surface | Simplify / build | Keep because it earns its place | Evidence and next check |
|---|---|---|---|
| Landing and sign-in | One obvious sign-in/create path; keep alternate methods in More; remove repeated product explanation after entry | Recovery, guest identity and explicit agent connection | Source inspected; exercise expired guest and resumed account separately |
| Invite entry | Show room identity and one next step; reuse account sign-in rather than a separate onboarding wizard | Who invited you, granted scope, expired/revoked link errors | Production disposable invitation already exercised; not real-human research |
| Room picker | Search and recent rooms; avoid a second navigation bar inside a room | Room switching and Create room | Source inspected; check zero, one and many rooms |
| Room sidebar | Channels and people are orientation; remove standalone Results | Unread state, current room, agent availability | Results removed locally; inspect long names and narrow widths |
| Top bar | Search, context, and one More menu; move refresh away from the happy path in a future focused change | Visible degraded-connection recovery when needed | Source inventory finds global Refresh and attention Refresh; unify their semantics before deleting either |
| Chat timeline | One message hierarchy; collapse routine machine progress; remove repeated Completed labels and metadata | Author, audience, time on demand, errors, material changes | Result journeys exercise chat continuity; audit runtime progress messages next |
| Composer | Chat as default; one send action; attachments and uncommon controls contextual | Private recipient indicator, pending upload, exact retry target | Private-draft and uncertain-send checks retained |
| Threads | Clear Back and source context; secondary mute controls in context menu rather than permanent chrome if discoverable | Parent message and audience | Test return preserves channel draft and scroll |
| Tasks in conversation | A short status and useful next action; details collapsed; no competing result export buttons | Owner, blocker, required approval when relevant | Existing task cards retained; task form reduction is separate from this preview slice |
| Board | Treat as optional overview, never prerequisite for asking or following work | Cross-task planning for people who need it | Do not replace its modal mechanically without testing navigation and origins |
| New work | Derive a proposed task from conversation; show only missing consequential choices | Explicit submission and accountable owner; do not invent approval | Current confirmation checks retained; avoid mandatory setup for ordinary chat |
| Results and previews | Remove separate results workspace; use source message or adjacent preview | Exact historical version, readable long material, Reply | Drag/reload/mobile tests plus withdrawal, revocation and draft tests |
| Comparison | Fold under the document; no permanent competing pane | What changed when reviewing a revision | Check long diff cannot push footer outside viewport; delayed withdrawn versions must clear |
| Catch up and attention | Distinguish unread activity from an action required of this person; no inbox rebuild | Actual blockers, approvals and failed actions | Existing live freshness/permissions retained; inspect whether one entry can serve both without mixing semantics |
| Saved / reminders | Keep under More and message context; no permanent sidebar count for zero items | Deliberate personal retrieval | Source inspected; no email workspace |
| Search | One search surface including completed work; avoid teaching a second search app | Older history, mentions/pins, permission-filtered results | Results links populate query; test filter composition before adding chips |
| People and agents | One membership model with clear role and availability; consolidate human-facing invite entry where safe | Different credential and scope needs for agents | Do not merge private setup into shareable invitations |
| Add agent / Use my AI | Different jobs: persistent connection versus one-off external draft; explain at the choice, avoid repeated instructions | Scoped credential handling and copy fallback | Source inspected; real provider execution remains unqualified |
| Settings | Configuration only; remove read-work destinations and operational dashboards | Security, membership, policy and account recovery | Results moved out; remaining settings need role-specific walkthrough |
| Approval / destructive action | Show consequence and exact target; remove boilerplate, not the boundary | Approval is a human decision, not hidden agent automation | Existing stale-version and authority checks remain necessary |
| Offline / reconnect | Quiet status while retrying; one actionable recovery when needed | Unsent text and uncertain writes must never disappear | Resume and uncertain-send tests retained |
| Mac app | Same workspace and behavior as web, native window lifecycle | Durable drafts and actual WKWebView reload/reopen | Native acceptance passed previous shipped source; rerun new design before qualification |
| Mobile | Same information model, one reading surface at a time; no miniature desktop panes | Touch targets, keyboard visibility, Back and draft retention | Browser touch emulation is not physical-device evidence |
| Agent tools | Compact typed reads, stable identifiers, idempotent writes and exact version receipts | Agents need richer machine context than people need on screen | No backend API deletion in a visual cleanup; monitor context bytes and successful retries separately |

## Visual and interaction checklist

Check light/dark, 390px phone, tablet/narrow desktop, 1440px desktop, long localized labels, long author names, empty and dense rooms. Check 200% zoom, keyboard-only use, reduced motion, focus visibility, escape behavior, touch target size, scroll ownership and document overflow. A pane resize must not steal the composer draft or change the selected result. A permission loss must clear displayed private material immediately.

Use spacing and typography already in the design tokens. One primary action per task state. Muted metadata must remain legible. Avoid decorative cards around every sentence, extra badges for the same status, and headings that repeat the selected navigation label. Tooltips explain icons; permanent paragraphs should explain consequential choices only.

## Order of work and completion criteria

1. Finish this result/preview slice, including native reload recovery and all affected navigation checks. Capture desktop and mobile screenshots and inspect them. No failed checks disguised as UI simplification.
2. Reconcile release evidence and the existing plan. Keep earlier deployed evidence separate from the new source revision. Record real-human, real-provider, physical-device and notarization limitations explicitly.
3. Consolidate redundant controls in chat and task cards only after a role-aware walkthrough. Prefer one focused commit per behavioral change, so it can be reverted independently.
4. Unify the human invitation surface while keeping credential flows distinct internally. This is a candidate next build, not automatically part of this release.
5. Review attention versus catch-up with realistic activity before merging them. Similar appearance is insufficient evidence of duplicate function.

Measure steps from invitation to first useful exchange; steps from result to feedback; interruptions/modal transitions per journey; visible controls in the default viewport; draft loss and duplicate sends (target zero); inaccessible or stale-version disclosures (target zero); keyboard completion; read/reply latency; and agent context bytes per completed task. Fewer controls is useful only if task success, discovery and recovery do not worsen. Do not substitute simulated usability scores for observations from people.
