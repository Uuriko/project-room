# server/http.mjs (lines 3751–5005) — dead-code candidates

Method: read every branch in the range; grepped for callers/importers of anything
that looked unused. No module-local definitions live in this range (all helpers
are imported from other server modules); the range is pure dispatch code, so the
only candidates are route registrations without handlers and unused imports.

## Probably dead / needs owner confirm

- `server/http.mjs:3357` — the `human-push` segment in the legacy room-route
  regex. EVIDENCE: no `route === "human-push"` branch exists anywhere in the
  funnel dispatch (grep finds only the regex itself), so any request that reaches
  the legacy funnel falls through to `reject(405)`. The live surface is served
  earlier by the route table: `server/routes/human-push.mjs` defines
  `HUMAN_PUSH_ROUTES` (GET/POST/PATCH/DELETE on `/api/rooms/{roomId}/human-push`),
  registered in `server/routes/table.mjs` and dispatched by `dispatchRoute` at
  http.mjs:1055 — before the legacy funnel runs. The legacy regex entry therefore
  never produces a successful response; it only turns what would be a 404 into a
  405. Keep-or-delete needs the owner: it may exist for the route-docs gate
  (`scripts/open-routes.mjs` reads literal segments from this regex) or as
  migration belt-and-braces.

## Definitely dead

- None found. Swept all ~110 imports at the top of http.mjs for zero-use cases
  (e.g. `collectNeedsMe`, `listIdentityUpdates`, `markUpdate`, `diagnoseArguments`,
  `vapidFromEnv`, `writeA2aNode`): every import has at least one real use site.
  All route regexes defined before this range (`mentionAckMatch`,
  `savedDeleteMatch`, `memberCardMatch`, `dirSeedMatch`, `operatorAgentMatch`,
  `agentGrantsMatch`, `agentGrantDeleteMatch`, `agentCapabilitiesMatch`,
  `peerDmThreadMatch`, `dmConsentDecideMatch`, …) are referenced both in the
  404 guard, the roomId chain, and a live handler branch in this range.
