# Two Macs, one room

Design decision, 2026-10-22: one path — **Join → Connect → Share → Test**. A public room presents one setup prompt; the same instructions work in an agent and as an installable skill. Resume completed steps. Keep advanced choices under Customize and ask only for unresolved decisions. Room publishing and open admission remain separate owner choices.

## Recommended experience

1. Open the intended room on each Mac. Reuse each agent's own identity and confirm the same origin and room ID. A pending invitation has one next action: owner review.
2. Connect this Mac. Reuse the desktop app, provider login and workspace when present. Missing app: use the verified official download when available; preserve room access if desktop installation is blocked.
3. Offer Work together: one chosen project folder, one job at a time, manual start/pause, no new paid usage. Show the concrete scope before enabling. Customize exposes additional folders/data, compute limits, model budgets, background availability and computer control only when supported.
4. Complete one bounded task in each direction. Test stop before showing both Macs as ready.

The recommended scope is a proposal, not an assertion that the present host enforces all these controls. Current native host tools are broad owner-enabled tools; a folder picker alone is not a sandbox. Unsupported restrictions must leave the corresponding sharing mode unavailable.

## Deep sharing agreement: next implementation boundary

A useful agreement identifies two host identities in one room and contains independently approved outgoing grants. A may share more than B. Each grant names its recipients, operations, resources, limits, expiry and host-enforced policy revision. Any scope expansion needs a new approval; retries use stable IDs. Revocation invalidates the old revision before any new job starts. Active-job cancellation is reported separately.

Use the existing unified activity feed for request, approval, refusal, expiry and revocation, with a stable link to the agreement. Do not build a second inbox. Native host consent is separate from Room membership and maximum Room permissions. A room chat agreement is intent, not enforcement.

Implementation order:

1. Ship the canonical setup prompt, public discovery, resumable join and access requests.
2. Implement host capability reporting with fresh heartbeat and supported/enabled/tested states. Do not advertise capabilities from installed tool names alone.
3. Implement host-enforced grants and a durable agreement lifecycle. Check the current grant on every dispatch and execution; reject stale, mismatched-room, wrong-recipient and revoked work. Fail closed offline. Reuse native controls; do not expose a raw unrestricted command relay.
4. Render one review card for the concrete requested scope, with Customize, Accept and Decline. Each owner reviews their outgoing grant. Keep Pause always visible.
5. Exercise the two real Macs: request → approve → bounded task → result → pause → refused new task, in both directions. Also test duplicate delivery, expired grants, host restart and interrupted jobs.

Success means an unfamiliar owner can use the same prompt, see one next action, complete a shared task, and stop access without maintainer intervention. Measure setup completion and time, points needing assistance, task success and successful revocation. Do not count a roster entry as success.

## Evidence and limits

- Nielsen Norman Group, [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/): show the important choices first and defer specialized options. This is established usability guidance, not a trial of Project Room.
- Apple, [Turn Mac screen sharing on or off](https://support.apple.com/guide/mac-help/turn-screen-sharing-on-or-off-mh11848/mac): device access has explicit local controls and allowed users. The Room flow should explain and preserve that boundary.
- Tailscale, [Share your machines](https://tailscale.com/docs/features/sharing): sharing a selected device has a distinct scope and acceptance flow. We borrow the conceptual distinction, not a requirement to install another networking product.

Observed locally: the native app exists but local tools were paused and the agent was not configured. AirDrop success was reported by the owner; remote app installation, membership, and two-way execution remain unverified. Public signed/notarized distribution is still pending Apple Developer enrollment. These are open setup facts, not completed milestones.
