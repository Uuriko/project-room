# http.mjs lines 2501–3750 — dead-code candidates (WAVE-400)

Method: scanned every `const`/`let` declaration in lines 2501–3750 for zero
references outside its declaration line (substring scan over the whole file);
manually reviewed every route template for callers in `server/`, `client/`,
`src/`, `tests/`, `docs/`, `cli/`, `skills/`; checked the funnel matchers
against the 404 guard, the roomId chain, and the `route` ternary.

## Definitely dead

None found. Every declared matcher (`landAdd`…`creditsMatch`, `boardV2*Match`,
`updates*Match`, `revokeMatch`, `threadMatch`, …) is referenced in the 404
guard and/or the roomId chain and/or a dispatch block, and every route template
has live callers:

- `report_tip` / `add_land_item`: `server/mcp-hosted-tools.mjs`,
  `server/mcp-room-profile.mjs`, `client/room-land.mjs`, `src/room-mcp-join.js`.
- `identity-create` alias: `server/access-requests.mjs`,
  `server/agent-identities.mjs`, `server/agent-plugin-manifest.mjs`,
  `server/discoverability.mjs`, `server/guest-invites.mjs`.
- `guest-invites/rotate`: `tests/guest-invite-flow.test.js`,
  `tests/guest-bearer-origin.test.js`, `docs/GUEST-AGENT-LINKS.md`.
- `referral-invites/preview`: `server/referral-invites.mjs`,
  `tests/referral-invites.test.js`, `docs/INVITE-ONLY-CHECKLIST.md`.
- `claims/validate`: `server/claim-validate.mjs`, `tests/claim-validate.test.js`,
  `server/discoverability.mjs`.
- `join-agent`: `server/discoverability.mjs`, `server/jev-admission.mjs`,
  `client/room-agent.mjs`, `src/app.js`, `src/room-roster.js`.
- `operator/agents`: `server/autonomy-tiers.mjs`, `tests/autonomy-tiers.test.js`,
  `docs/ADMIN-GUIDE.md`.
- `board/v2/*`: retired but deliberately alive — the matchers are required for
  the 410 `board_v2_retired` answer at line 3850; the comment at line 63 says
  the `board_vtwo_*` tables stay in place.

## Probably dead / needs owner confirm

None found. The closest candidates were checked and ruled out:

- The `/api/identity-create` alias of `/api/agent-identities` looks redundant
  but is referenced by five server modules — keep.
- The invite-family 405 twins (e.g. 2559, 2959, 2980, 3011, 3024) look like
  boilerplate but are the deliberate POST-only-method contract — keep.
- The `route` ternary fall-through naming matchmaking/feedback/bounty/credits/
  boardV2 routes as `"ownership-transfer"` (line 3572) is intentional-ish and
  currently harmless (all dispatch blocks return); noted under gotchas, not
  dead code.
