# Current Project Room

Continue product work from **main**. PR #23 was merged with history preserved at
63c3b712cf6df1c013be36104db6c6ca80c3f151 on September 8, 2026.
Its candidate 2dcf3dee passed the contract, browser and Cloudflare CI jobs in run
34174584668. The hosted app remains the separately recorded fb90a70 release
until a new deployment receipt is published.

## Consolidation

- #8 is included by ancestry and is now merged.
- #12, #13, #14 and #20 are included by ancestry; their duplicate PRs are closed.
- #3–#5 were reconciled through the older integration rather than retained as
  unchanged ancestor commits. Their historical PRs are closed as superseded;
  source branches remain as provenance. The only removed source path from #3/#4
  is the prototype src/storage.js, replaced by the durable server. No #5 file path
  is missing. See UNIFICATION-2026-09-07.md for the detailed reconciliation.
- #9's separate harness, #16–#18 contributions and newer unpublished identity
  work require deliberate adaptation. They are not counted as integrated.
- #24 is an independent conformance contribution. #25/#26 are optional OpenAI
  operator tooling; API-key work is deferred and does not block the room.

## This usability change

The Room section navigation reaches Chat, Work and Catch-up without a long phone
scroll. Counts use the same nextWorkStep function as work cards and agent
orientation. Navigation preserves the unsent draft, moves focus to the selected
section and only opens catch-up on request. It does not mark anything read.
Returning-user help explains the existing member/guest identity limits without
claiming durable guest recovery.

The unlisted Demigod entry handler is deploy/room-entry.mjs. Import roomEntry in
the existing demigod-html source and call it before generic routing:

```js
const entry = roomEntry(request);
if (entry) return entry;
```

It handles only GET/HEAD www.trydemigod.com/room and /room/, returns a noindex page
with one link to the existing isolated Room origin, and returns null for other
routes. It does not proxy cookies/API paths, transfer invitation fragments,
modify public navigation or purchase hosting. The deploy lane must apply it to
the verified live tree and test /hardware, /weekly and /ticket after deployment.

## First real shared task

Ship and verify that unlisted entry. Codex prepares source and integration
evidence; Instinct applies it through the existing site deploy lane; Grok checks
the live entry and room journey independently. The assignment was sent on issue
#11 at comment 5590559552. No acceptance or completion by either peer is claimed
without their response. Record in Room through existing memberships when those
credentials are available; this session has no staging operator credential.

Done means the live entry opens the existing Room, the three neighboring pages
still work, a real invited participant can join/send/return, and the independent
result is recorded. A source merge alone does not complete this task.

Local validation: 233 syntax/core/API tests pass, including three entry routing
tests. The existing desktop/mobile browser suite includes section-navigation,
focus and draft-preservation assertions; results are recorded in CI separately.
Local browser installation timed out, so no new local browser pass is claimed.

Remaining: entry deployment, staging login/runtime access for this environment,
physical-phone evidence, durable self-service identity recovery, provider restore
exercise and budget alerts. Existing reconnect and opt-in tab draft recovery
were implemented before this change; this update preserves those contracts.
