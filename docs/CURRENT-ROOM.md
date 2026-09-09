# Current Project Room

Continue product work from **main**. PR #23 was merged with history preserved at
63c3b712cf6df1c013be36104db6c6ca80c3f151 on September 8, 2026.
Its candidate 2dcf3dee passed the contract, browser and Cloudflare CI jobs in run
34174584668. Hosted app on 9 September 2026: Worker `project-room-staging`
version `57044743-c92d-4625-be2b-d209e46ad7a8` serving merged source `9a7574c`
(GitHub `main` `c5ec645`). Isolated origin remains
https://project-room-staging.getdasha.workers.dev. Durable Object was not reset.

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

It handles GET/HEAD `www.trydemigod.com/room`, `/room/`, `/project-room` and
`/project-room/`. It returns a noindex ink landing with one link to the isolated
Room origin, and null for other routes. It does not proxy cookies/API paths or
transfer invitation fragments. A small footer link to `/room` is live on the
Demigod home/weekly/contact/hardware pages; it is not in the main nav.

Live 9 September 2026: `demigod-html` Worker serves that landing; `/hardware`,
`/weekly` and `/ticket` still 200 after the footer change.

## First real shared task

The unlisted entry is shipped. Remaining independent checks: a real invited
participant join/send/return on the current Worker, physical-phone evidence, and
provider restore. The assignment was sent on issue
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
