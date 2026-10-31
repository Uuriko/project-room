# Signed-in UX QA, 2026-10-31 (main 1ab906c3)

**How this was run**
- Local server from main, using the acceptance fixture: an owner plus seeded people and agents.
- A new "Friend agent" was invited through the owner UI and joined with `agent-inbox.mjs join`. It acted over stdio MCP (`scripts/agent-mcp.mjs`).
- No prod rooms were created.
- Playwright with Chromium at 390x844 and 1280x900.
- All flows were run end to end: invite, join and access check, find work, assign, accept, start, draft, submit, owner check, approve, thread, Updates/needs-me, Board, attachments, DM and revoke.

**Clean areas**
- 0 console errors or warnings, and 0 HTTP responses of 400 or above, across every flow at both widths.
- No horizontal page overflow on room pages.
- Every visible button has an accessible name and every form field has a label. No duplicate IDs. `lang=en` is set.

**Timings** (server round trips; UI steps exclude fixed waits)

| Step | Time |
|---|---|
| Mint agent invite | 113 ms |
| Agent join preview | 258 ms |
| Agent join accept | 200 ms |
| check / next | ~120 ms each |
| Create work | 95 ms |
| Agent accept / start / draft / submit | 50 / 49 / 39 / 46 ms |
| Owner check save | <1 s |
| Owner approve | <1 s |
| Revoke | effective on the agent's next call |

No step was slow. The friction is in how many steps there are and in the copy.

## Findings, ranked by MVP impact

**P1-1. Agent cannot submit a result without reading the source**
- `room_submit_text_result` requires 8 fields. One is an `evidenceVersion` that the agent has to compute itself, as sha256 of the draft body.
- Any wrong argument returns only `-32602 Unknown tool or invalid arguments`, with no field named. The same happens for `room_post_draft` (needs `packetId` and `basisRevision`) and `room_post_message`.
- `room_post_draft` returns `messageId` and `eventId` but not the version the submit call needs.
- Repro: as an agent, accept and start an assigned task, then call `room_submit_text_result {workItemId, summary}`.
- It took 6 attempts.

**P1-2. Member agent cannot see DMs or @mentions addressed to it**
- For an agent invited as Member, `room_read_inbox` returns `insufficient_scope`.
- After the owner DMed the agent and @mentioned it in a thread, `next` still reports `needsMe: 0` and `openReplyRequests: 0`.
- Only a full `room_read_messages` scan shows them.
- Repro: owner sends a DM to Friend agent, then the agent runs `next` and `room_read_inbox`.

**P1-3. Wrong actor in the activity line** (screenshot `14-delivered-line-390.png`)
- After the owner records the independent check, the channel line becomes "Room owner marked <task> delivered". The agent delivered it, and its own line is replaced. After approval it reads "Room owner marked <task> done".
- Source: `board-ui.js` line 166, which uses the actor of the claim-state change.
- Repro: run the full loop, then record a check as owner.

**P1-4. Raw member IDs in owner UI** (screenshots `12-verify-dialog-390.png`, `16-approved-390.png`)
- Shown as "Friend agent (ai_eb5c…)" in the assignee and verifier selects, the check and decision dialogs, and the Completed card.
- At 390 the ID runs past the edge of the check dialog.
- `app.js` `memberLabel` always appends the ID, while `member-display-names.js` adds it only when two names collide. Check the impersonation tests before changing.

**P2-5. Invite preview contradicts itself**
- The join preview shows `requestedAccess: {preset: "chat", permissions: []}` next to `preview.permissions` that include `write_external`.
- The owner-side label "Member · work, review, claims" doesn't mention external writes.

**P2-6. Raw field name in a validation error**
- Creating work without a verifier shows "verifierId is required — complete it before saving."
- The field is labelled "Verifier" but its placeholder says "Choose reviewer".

**P2-7. One review state, many names** (screenshots `09-updates-1280.png`, `10-review-1280.png`)
- The same state is called "Awaiting review", "VERIFY", "Awaiting verification" and "Record independent check".
- Updates lists it under "Decisions" and shows two rows for the same task.
- Approval sits behind the check: check, then "Review the evidence and make a decision", then Approve. That's 3 dialogs or clicks.

**P2-8. DM shows channel activity** (screenshot `23-dm-sent-390.png`)
- A private conversation opens with "Room owner marked … done" at the top.

**P2-9. Removed agent is told the wrong next step**
- It gets "Access was not accepted … ask the owner for the missing permission", and `check` points to `doctor`.
- It should say the agent was removed from the room.

**P2-10. Board is hard to reach and hard to read** (screenshot `20-board-1280.png`)
- It's only reachable through Go to (Ctrl K). It isn't in More or the sidebar.
- It opens with admin controls first: New item form, Claims per member, Close stale, and "Deploy status unknown" in a room with no deploys.
- Ready shows "Nothing here." even though `test-handoff` is awaiting acceptance.

**P3 issues**
- **11.** At 390 the Updates count wraps below its label.
- **12.** Every human post and DM shows the toast "Agent execution is not confirmed by delivery."
- **13.** The owner's own decision reason triggers a "1 new message · jump to latest" pill and a NEW MESSAGES divider.
- **14.** An agent's participant row shows its status twice ("Idle · DONE · Idle", "No live signal" ×2). The member panel prints the same ID twice, as Member ID and Agent identity.
- **15.** Invite at 1280 is hidden under a collapsed "Add people". The dialog has two primary buttons ("Create invitation for an agent" and "Create invite link"). It offers "Co-owner · Muse development" in an unrelated room. Screenshot `02-invite-dialog-390.png`.
- **16.** The "Make this a task" chip sits above the composer without saying which message it refers to, and it stays after work is created. Screenshot `01-entry-1280.png`.
- **17.** "Refine draft" is still offered on an approved result.
- **18.** The "⋯" message menu button is 22x32 px, which is narrower than the WCAG 2.5.8 minimum of 24 px.
