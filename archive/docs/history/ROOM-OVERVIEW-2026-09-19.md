# Room Overview checkpoint

## Product decision

Keep the familiar room conversation and private Inbox. Add orientation at the room boundary before expanding global navigation: users need to understand a project without reading its entire conversation. Existing purpose, decisions, work and results provide that orientation; another persistent dashboard model does not.

This slice adds an Overview button in the room sidebar. It opens a small read-only dialog with purpose, up to three next steps for the viewer, three recent decisions and three completed results. The dialog is an incremental surface, not the proposed full navigation shell. It requires no new account-wide feed, route, schema, external request or public asset entry.

Entries link to existing work or discussion. Results use the established completion selector, so a result awaiting required verification is not presented as finished. The projection refreshes while open; reopening completed work removes it from recent results. Session termination closes and clears the surface.

Source-message navigation now selects its channel before focusing the original record. On mobile, following an Overview link closes the covering sidebar as well as the dialog. Ordinary close returns focus to the Overview button. Conversation drafts remain in place.

Removed internal release-code/agent-coordination prose from the visible People hints and replaced it with concise collaboration and permission guidance. The technical create-room disclosure remains available for agent setup.

## Validation

- 30 browser checks passed across Overview, results, decisions, draft return and channels.
- 3 polish checks passed (Overview desktop/mobile repeated after the copy edit, plus People sidebar): **31 distinct browser checks in total**.
- **36 focused unit checks passed** for result selection, contribution steps, channel behavior, roster markup and journey registration.
- Repo check with CI mode passed; its root unit runner is intentionally skipped in that mode, so this is not a full-root-suite claim.
- Lint: zero errors, 79 existing warnings. Diff check passed.
- Desktop 1440×1000 and mobile 390×844 screenshots inspected. No horizontal clipping observed; narrow viewport layout checks pass.
- New journeys verify cross-channel source links, draft preservation, live result removal, no room writes or off-origin requests, close/source focus, and clearing after access-key rotation.

The new browser file is registered in test:browser and therefore picked up by the existing browser CI wrapper. Logs and screenshots are in ignored test-results/room-overview/. The full browser/root suites have previously documented failures and were not rerun for this bounded slice.

## Next implementation boundary

Rooms and Inbox already have canonical account navigation; do not introduce a second navigation owner just to redraw the shell. Extend that existing owner with explicit destination state and back/forward behavior. Keep room/channel/thread selections separate from the account destination so private drafts and room state survive switching.

Activity currently means room-scoped Catch up. A global Activity tab needs an authorized account-level aggregation contract, source room labels, cursor semantics and paging. Until that exists, any accessible Activity surface must clearly state its room scope. Do not rename the room feed and imply it covers all memberships.

For future Overview expansion, preserve these constraints: it is a projection; every item opens its source; opening it does not acknowledge unread messages; private Inbox content never enters it implicitly; and new panels require a demonstrated user need. No global dashboards, additional providers or automatic summaries in this slice.

No push or deployment.
