# Agent-assisted private reply checkpoint

## Delivered locally

One reusable journey now exercises the existing product from a private source through selected sharing, a help invitation, an agent offer and exact draft, explicit result adoption, review, owner approval and a private reply. The synthetic transport deliberately loses its acceptance acknowledgement; status lookup reconciles the same send without a second submission. Helper release remains explicit and does not claim to stop outside activity.

The journey uses the real browser controls for simulated people and the existing MCP/direct client for agent participation. It introduces no production workflow, database schema, provider or dependency. The staged fixture exposes only named browser stages, retains screenshots/readback separately and removes its temporary sample database and credentials when closed.

Inbox now remembers the selected message and reading position across reload and Rooms navigation. Metadata is per tab and bound to the account session and source revision; it contains no message text, address or credential. A newer source resets position. Sign-out and account changes clear it. Mobile Inbox navigation stays visible while reading long messages.

## Evidence distinctions

- The root assistant personally read the selected excerpt over MCP, composed an original offer and 94-byte reply, reconnected and retried exactly, read the result back and explicitly released its offer. This was a candidate run before the final position-restoration change, not a blinded test or native-host qualification.
- Owner and reviewer in that exercise were separate simulated browser identities. Their permissions and decisions were tested; they were not independent human evaluators.
- The automated desktop/mobile counterparts use scripted MCP input, including exact retry through a fresh process. They do not call a model. They assert one draft event, one synthetic provider submission, no private source marker or addresses in agent responses, exact draft provenance and no automatic approval-to-send or approval-to-release transition.
- Screenshots are viewport captures with overflow checks. Browser traffic is restricted to the disposable local origin. No real message, payment, provider request or deployment occurs.

Candidate actual-assistant evidence: `room-inbox-collaboration-evidence-suPJMR` under the system temporary directory. The root repeated the full exercise on runtime commit `3858cfe` with a fresh original 91-byte draft, exact reconnect/retry and direct readback, simulated review/approval, one synthetic submission with status recovery and explicit release. Both temporary sample/credential directories were removed on normal close. Retained screenshots and readbacks are in `test-results/agent-assisted-reply-3858cfe/root-assistant` and `root-final`. Final automated test counts belong in the accompanying checkpoint evidence, not inferred from earlier candidate passes.

## Reuse

Run `node scripts/inbox-collaboration-journey.mjs --start` in a terminal. It prints a local connection directory and work ID. Participate with the existing MCP client, then submit JSON stages on stdin: select, adopt, review, finish, read, close. Inspect the stage implementation for required exact IDs/text. Never reuse this synthetic launcher for real mailbox credentials.

`scripts/inbox-collaboration-check.mjs` is included in the full browser suite. Continuity checks live with the existing Inbox tests.

## Still unfinished

Runtime `3858cfe` passed syntax checks, 734 core tests, 224 full browser tests and 18 local Workers tests, with all processes exiting zero. Final logs, classification and inspected screenshots are retained in `test-results/agent-assisted-reply-3858cfe`. This documentation update does not change runtime.

Inbox independent of room membership, real email/provider qualification, native-host compatibility, independent human usability testing and the broader automation/rewards roadmap remain separate work. This checkpoint does not establish live deployment, real delivery, retention or genuine independent review.
