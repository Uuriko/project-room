# Project Room — restart here

**Final handoff:** start with [FINAL-LOCAL-ACCEPTANCE-2026-09-07.md](FINAL-LOCAL-ACCEPTANCE-2026-09-07.md) for the verified local milestone, current runnable fixture, evidence and separate next-phase gates. The stopping states below are historical.

**Later resumed work:** [BROWSER-GUEST-ACCEPTANCE-2026-09-07.md](BROWSER-GUEST-ACCEPTANCE-2026-09-07.md) supersedes the live state and remaining guest checklist below: 163 tests, committed-response-loss retry, persistent one-guest/one-use evidence, manager feedback and retry-focus fixes, CLI verification, and a test-tab input limitation.

John requested a good stopping point. Implementation is stopping at this checkpoint; the broader goal is **incomplete**, not blocked or release-ready. The goal tool still reported active when checked; this report does not change its scheduling or claim it is paused.

## Saved and verified

- Shareable guest access, invitation feedback, visible-owner identity preservation, and actionable join-timeout recovery are implemented. Earlier browser evidence is in BROWSER-RESUME-2026-09-07.md and BROWSER-CHECKPOINT-2026-09-07.md; those reports describe different candidate revisions.
- The synthetic handoff reached approved revision 9, with a corrected exact artifact, distinct producer/reviewer records, and a synthetic owner decision. Recovery after a real local service restart was browser-verified. This is neither a live AI collaboration nor John's real approval.
- Enlarging root/body text from 16px to 32px exposed horizontal overflow: the 1280px viewport had 2208px document width. The new font-relative container layout in src/styles.css reduced that to 1280px while preserving the ordinary desktop grid. At 390px with enlarged text, the document measured 390px and the join/management dialogs measured 318px client and scroll width. This is controlled text enlargement, not native browser zoom or a physical-device accessibility certification. Final enlarged work-control checks remain.
- Clipboard failure fallback was tested with a one-shot simulated NotAllowedError on the disposable page. The link was focused and fully selected (0–72), and manual-copy guidance became visible. The exact previous clipboard implementation restored itself; the next normal copy succeeded. The browser did not support changing clipboard permission through this control, so actual denied-permission behavior remains untested. No permission was changed.
- Reran the current syntax/core/API suite at stopping time: **160 tests passed; zero failures or skips**. `git diff --check` passed. No new full standalone browser-suite pass is claimed.

Current source/test/config digest: `9fb8b5f4a1d721e79397ae72ae124df8b1258b1c095a1156c4a4fb16cf07ca27`.
Base HEAD: `7b5e92fa3245eab684e4a0f2e9c8f16c90441801`; branch `codex/project-room-canonical-20260906`. Retained tracked/untracked changes are essential to this candidate and have **not** been committed or discarded. The digest excludes documentation.

## Browser cleanup and evidence

Removed the temporary enlargement stylesheet, reset the viewport override, and closed the invitation without joining. Final measured body text is 16px, viewport/document width 1280px, with zero open dialogs. The disposable tab remains signed in as the test owner. No clipboard test override remains. Original preview at http://127.0.0.1:52330/ was not changed by these tests.

Evidence lives in `test-results/acceptance-2026-09-07/`, ignored by Git but saved locally. There are 16 PNG files; numbering intentionally skips 13 because that capture did not finish.

- `11-enlarged-layout-before.png`: overflow before the fix.
- `12-enlarged-layout-fixed.png`: fixed enlarged desktop view, visually inspected.
- `14-copy-fallback-synthetic.png` and `15-copy-fallback-guidance.png`: synthetic clipboard refusal and manual copy guidance.
- `16-enlarged-narrow-join.png`: enlarged scrollable join dialog, visually inspected; not a completed enlarged join submission.
- `17-stopping-point-normal-view.png`: final restored browser, visually inspected.
- Earlier files 01–10 retain the review/correction, approval/restart, invitation, narrow, pending and timeout evidence described in the prior reports.

All content is synthetic. Some clipboard screenshots may show part of a disposable invitation token; do not publish them as if scrubbed of all tokens. No production credentials are included.

## Resume in this order

1. Read this file, the preceding browser reports, current code and the board/bus. Preserve all retained changes. Browser access is working; old policy-blocker notes are historical.
2. Finish current-build **new guest** and **existing guest** browser regression, including conversation-only permissions and draft/reply continuity. Owner room-key and older guest account cookies coexist in the disposable browser; distinguish visible-member reuse from creating a genuinely new guest. Never manipulate the original preview's cookies.
3. Verify uncertain guest redemption and same-request retry in the browser without duplicate identities/uses. Existing automated tests cover ownership/idempotency, but a committed-response-loss browser check has not yet been demonstrated.
4. Finish 200% text and ordinary narrow checks on work next-action controls, plus join submission and error-focus/retry behavior. Complete source-message → proposed-work creation through the current UI; the demonstrated completed handoff began with seeded proposed work.
5. Check invitation-management transport failures: creating a link showed raw “Failed to fetch” once, then retained-request retry succeeded with one 0/2-use link. Consider reusing the existing actionable transport-error helper in manager catches, with focused tests. Do not mistake this for a resolved manager error-copy issue.
6. Rerun tests after any code change, save/inspect evidence, and finish the requirement-by-requirement acceptance audit before completing the local goal. Keep independent review, actual agent runtimes, MCP compatibility, physical devices/assistive technology, operations and real-team dogfooding explicitly separate.

No more broad research, new agents, publishing, live integrations or spending is needed for these local checks.

## Local fixture recovery

Canonical working directory: `/Users/johnpotter/.codex/.chatgpt-projects/g-p-6a9b22adb83c81919c156230b24f4d4c/work/project-room-canonical`.

- Disposable URL: http://localhost:52331/; browser 1, tab 5 at checkpoint. Rediscover IDs on resume.
- Last known server execution session: 45215. No process is intentionally suspended; inspect the process before signaling or restarting it.
- SQLite file: `/var/folders/h3/r7zqdttd19v3xzb_q69dqkzc0000gn/T/project-room-acceptance-OiUVFY/room.sqlite`.
- Synthetic credentials: `test-credentials.json` in the same temporary directory, mode 0600. Do not copy its contents to reports.
- Seed invitation links have aged/expired. A new 24-hour, maximum-two-guest link was created through the owner UI, expiring September 8, 2026 at 00:52:12 Pacific; it still showed two available uses. Create another through owner UI if needed, rather than relying on expired tokens or old in-memory bindings.
- Both scripted handoff stages already ran. Do not rerun them against this completed fixture. Temporary data may be removed by the OS.

If the database still exists and no service owns the test port, reopen it using ROOM_DB, PORT=52331, HOST=127.0.0.1 and ROOM_ORIGIN=http://localhost:52331 with server.mjs, as documented in BROWSER-CHECKPOINT-2026-09-07.md. Otherwise start a fresh isolated fixture using `node scripts/acceptance-fixture.mjs --port 52331`. On this Mac Node is `/Users/johnpotter/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`.

This checkpoint is saved locally, not a commit, deployment, or completed-goal claim.
