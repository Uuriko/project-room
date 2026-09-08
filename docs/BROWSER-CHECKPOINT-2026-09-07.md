# Browser acceptance checkpoint — safe stopping point

**Later resumed progress:** owner approval and restart recovery passed; visible-owner reuse and timeout guidance were fixed and browser-checked; 160 tests pass. See [resumed acceptance evidence and next steps](BROWSER-RESUME-2026-09-07.md). The paused status and pending approval below describe the earlier stopping point.

7 September 2026 UTC. John requested a stopping point before restarting the goal. **Goal remains paused and incomplete.** Browser access is restored; the earlier policy blocker is historical, not the current blocker. No production readiness or independent review is claimed.

## Outcome

- Added a repeatable disposable fixture with a separate database, synthetic owner/guest/producer/reviewer identities, sample messages, proposed work, and valid/expired/cancelled/full invitations.
- Test origin is `http://localhost:52331`, separate from John's untouched `http://127.0.0.1:52330` preview. Different ports alone do not isolate cookies; the hostname separation is intentional.
- Found and fixed hidden invitation status messages: `form-status` requires the `visible` class, but the share-link code previously only set text. Both join errors and management/copy feedback now use a tested visibility helper.
- Final syntax/core/API suite: **157/157 passed**. `git diff --check` passed.
- Current source/test/config digest: `db92e67de7466e07be435f745528a4cd12624454bbbc33cee81daf9c57a73728` (same inventory method as the acceptance audit). Base HEAD remains `7b5e92fa3245eab684e4a0f2e9c8f16c90441801`; retained uncommitted changes are part of the candidate. No commit, push, merge or deploy.

## Browser observations, not inferred from API tests

| Scenario | Evidence / result |
| --- | --- |
| New guest link entry | Named Browser Test Guest entered without a key. Fragment removed from address bar; six members including the new guest displayed. |
| Guest conversation and grants | Message saved and heart reaction persisted. Work creation disabled; invitation management absent. |
| Guest draft continuity | Preview + Escape and same-member rejoin preserved draft, identity and composer focus. Manager still showed one consumed join, not two. |
| Invalid invitation states | Incomplete, expired, cancelled and full fixtures did not join. Initial detailed errors were hidden; fixed expired-link explanation was then visibly verified in a fresh tab. Cancellation/full errors should also be rechecked visually on the final build. |
| Owner invite management | Defaults 24 hours / 10 guests observed; changed to 1 hour / 2 guests, created successfully, copied with visible confirmation, cancelled with visible confirmation and secret field removed. |
| Dialog focus | Initial name focus and Escape return observed; manager close returned focus to Invite people. Native Tab reached the browser/body boundary before wrapping: full repeated Tab/Shift+Tab containment still needs formal verification. |
| Narrow layout | 390 × 844 checked; document width 390, dialog within viewport, scrollable management content, reachable cancel/close controls. Join screenshot inspected after waiting for viewport rendering to settle. Not a physical-device or 200% text-size test. |
| Owner draft | Error preview + close retained the owner draft and returned focus to composer. |
| Agent handoff in UI | Scripted API producer submitted first artifact; reviewer failed it. Browser showed BLOCKED revision 4 and producer as next actor. Correction + review then showed COMPLETED revision 8, new exact SHA-256 version and owner decision next. **Browser owner decision not yet submitted.** |

The UI's “independent pass” label refers to distinct permitted producer/reviewer identities in the local records. Both are operated by this test script; it is not evidence of organizational independence or a real independently operated AI review.

## Screenshots

Screenshots are local generated evidence under `test-results/acceptance-2026-09-07/` (ignored by Git). No real credentials are included in the saved screenshots. Two earlier inline captures showed the pre-fix error and management layout; they were not saved as standalone files and are not counted below.

- [Full failed-review page](../test-results/acceptance-2026-09-07/01-failed-review.png)
- [Blocked work / next actor detail](../test-results/acceptance-2026-09-07/02-failed-review-detail.png)
- [Corrected result awaiting owner decision](../test-results/acceptance-2026-09-07/03-corrected-awaiting-decision.png)
- [Fixed visible invitation error](../test-results/acceptance-2026-09-07/04-invitation-error-fixed.png)
- [Narrow-screen join](../test-results/acceptance-2026-09-07/05-narrow-join.png)

![Visible invitation error after the fix](../test-results/acceptance-2026-09-07/04-invitation-error-fixed.png)

## Resume exactly here

Canonical directory: `/Users/johnpotter/.codex/.chatgpt-projects/g-p-6a9b22adb83c81919c156230b24f4d4c/work/project-room-canonical`.

1. Check bus/board and retained work before edits. Read this checkpoint, then `ACCEPTANCE-AUDIT-2026-09-07.md`; its old browser-blocked language is historical.
2. Reuse the existing **disposable** localhost tab, not John's 127.0.0.1 room. It is left signed in as test owner, with an unsent synthetic draft. Viewport override was reset and the tab marked for handoff.
3. Test room server was left running in execution session `62030`. Database: `/var/folders/h3/r7zqdttd19v3xzb_q69dqkzc0000gn/T/project-room-acceptance-OiUVFY/room.sqlite`. Private synthetic credentials and fixture link tokens: `test-credentials.json` in that same temporary directory (mode 0600). Do not copy them into reports.
4. Inspect revision 8 and submit the **synthetic test owner decision** through the UI, verifying the exact corrected version and final next actor. Do not represent it as John's real approval.
5. Finish remaining browser checks: current-build guest path regression; cancelled/full detailed errors; same-owner rejoin and reply-context continuity; clipboard-denied fallback; pending join / network error / same-request retry; repeated Tab and Shift+Tab, error focus; 200% text enlargement; return brief and final state after restart. No alternate control mechanism if policy checks fail again.
6. Re-run current checks, inspect and save screenshots, update the acceptance evidence. Do not mark the goal complete until remaining local acceptance is actually met.

The browser's refresh operations retained an old document during this run despite updated no-store server assets. A fresh tab in the **same approved browser** loaded the corrected code and showed the fixed error. Verify visible changes before counting a reload as a new-build test.

## Repeatable setup and reset

From the canonical directory, using Node 24.19+:

```sh
node scripts/acceptance-fixture.mjs --port 52331
```

This always creates a new temporary database. It never accepts an existing database path or deletes previous fixtures. Stop its own process before reusing the port; rerun for a clean reset. It prints the fixture directory and private credential-file location, not credentials. Synthetic producer/reviewer stages:

```sh
node scripts/acceptance-handoff.mjs /absolute/path/to/test-credentials.json first-review
node scripts/acceptance-handoff.mjs /absolute/path/to/test-credentials.json correction
```

Each stage requires its expected starting state and refuses non-localhost destinations or rooms without the exact disposable fixture identity. These scripts are test scaffolding, not a live agent integration. The current fixture already completed both stages; do not rerun them against it.

If the existing test process stops and its temporary DB survives, it can be reopened without provisioning or rotating keys:

```sh
ROOM_DB=/var/folders/h3/r7zqdttd19v3xzb_q69dqkzc0000gn/T/project-room-acceptance-OiUVFY/room.sqlite PORT=52331 HOST=127.0.0.1 ROOM_ORIGIN=http://localhost:52331 node server.mjs
```

Check that the file exists before reopening; otherwise use a new fixture. On this Mac the Node executable is `/Users/johnpotter/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`. All services remain loopback-only. Temporary data may be removed by the OS; no real data depends on it.

## Remaining broader gates

Live agents, MCP compatibility, independently operated reviewers, physical devices/assistive technology, production operations, hosting and real-team dogfooding are separate and uncompleted. No new agents, external accounts, publication or spending occurred.
