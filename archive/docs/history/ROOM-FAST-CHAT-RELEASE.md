# Chat first, depth on demand

The default human experience is conversation. Keep room/channel identity, Search, Catch up, More and the composer visible. Activity, Saved, Find an action and Settings sit in More. Settings contains permissions and an Advanced disclosure for Landing and Referrals. Shortcuts and the action finder remain available. Advanced tools remain reachable even when a room has not used them.

## Implemented

- One timeline render per snapshot; unchanged message attributes are not rewritten.
- Closed history/decision records are not built until opened. Results-only settings does not build hidden history.
- Ordinary messages do not fetch unchanged request-run subscriptions. New open requests refresh immediately; existing periodic status refresh remains.
- Secondary boards load only when their enclosing disclosures and dialog are open. Closing Settings closes the boards.
- Claude’s own-question suggestion fix and optional Ask @Agent suggestion are included. The suggestion prefills a mention; it does not send or start an agent.
- Agent discovery can explicitly select conversation, work, review or automation tools, with full authorized discovery still available. Permissions are unchanged.

## Evidence and limits

A synthetic local Chromium run with 300 historical messages measured one incoming message. Timeline passes fell from 2 to 1, message HTML computations from 606 to 303, timeline mutation records from 3,028 to 2, and hidden history replacements from 1 to 0. These are structural measurements, not production benchmarks. Single-sample visible latency stayed about 79 ms and still required one full snapshot GET. Full-snapshot transport and message-history string computation remain candidates for future profiling.

The behavioral regression protects unchanged historical DOM, hidden history, fresh visible history and request-run fetch counts. It failed before the fix. Existing browser journeys cover keyboard/focus, mobile navigation, draft preservation, Trust authority, lazy imports and unread positioning. An old unread test waited for any divider; it now waits for the selected message’s divider rather than racing an existing divider.

## Combined release

Includes source histories from PRs 1176, 1180, 1181, 1183, 1184, 1187, 1190, 1191 and 1193, plus merged 1194 and the reviewed handoff from 1195. Conflicts preserve both receipt/generation ledgers and recovery coverage. The pitch generator now uses the actual room-scoped receipt schema; a real MCP regression caught the original incompatible column lookup. Discovery copy distinguishes immediate links, GX passes and self-service, preserves identity reuse, and describes signature verification accurately.

Paid-work offers are draft quotes, not collected revenue. Recruitment generators return artifacts and do not publish them. Ring-detection libraries are offline simulations, not runtime enforcement. Guest capability PR1148 remains held with concrete unresolved writable-schema, recovery and actual Worker rollback validation gaps; it is not silently included.

## Design references

[Slack sidebar preferences](https://slack.com/help/articles/212596808-Adjust-your-sidebar-preferences) support putting secondary destinations under More. [Discord onboarding](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ) supports selective defaults without removing deeper access. Neither establishes that Room is faster. Historical [Slack frontend boot work](https://slack.engineering/gantry-slacks-fast-booting-frontend-framework/) and [Discord message storage](https://discord.com/blog/how-discord-stores-trillions-of-messages) motivate measuring unnecessary work; their infrastructure is not copied into this release.

Release status and live revision belong in the final deployment receipt after exact combined checks pass.
