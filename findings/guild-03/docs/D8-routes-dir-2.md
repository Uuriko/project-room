# Guild-03 docs — D8: server/routes/ directory catalog (part 2)

Verified against code at origin/main b53c52af (2026-10-09).

## member-permissions.mjs (84 lines)

`requestMemberPermissions`, `listMemberAccessRequests` +
`MEMBER_PERMISSION_ROUTES`:

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/rooms/{roomId}/access-requests` | room | request a permission grant |
| GET | `/api/rooms/{roomId}/access-requests` | room | list (owner/delegate view) |
| POST | `/api/rooms/{roomId}/members/me/permission-requests` | room | self-service variant |

## record-rails.mjs (44 lines)

`RECORD_RAIL_ROUTES` — analytics/record rails under
`/api/rooms/{roomId}/record-rails/*` (auth `room`). Append-only event rails
for room metrics.

## room-assistant.mjs (33 lines)

`roomAssistantRoute(ctx)` + `ROOM_ASSISTANT_ROUTES` (GET/HEAD/POST
`/api/rooms/{roomId}/assistant`, auth `room`, scope `room`). Thin HTTP
adapter over `RoomAssistant` (server/room-assistant.mjs) — context read and
assistant actions. Local attention tools stay off the MCP URL; this route is
their HTTP surface.

## spend-grants.mjs (82 lines)

`issueSpendGrant`, `revokeSpendGrant`, `readOwnSpendGrant` +
`SPEND_GRANT_ROUTES`:

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/rooms/{roomId}/spend-grants` | room | issue a spend grant `{to, amount, …}`; amounts validated (no negatives) |
| GET | `/api/rooms/{roomId}/spend-grant` | room | read own grant |
| DELETE | `/api/rooms/{roomId}/spend-grants/{agentId}` | room | revoke |

Backs the spend-primitive (`chargeSpendBeforeCall` in the MCP profiles
charges against these grants). See also spend-pricing.

## spend-pricing.mjs (54 lines)

`getSpendPricing`, `setSpendPricingRoute` + `SPEND_PRICING_ROUTES`:

| Method | Path | Auth |
|---|---|---|
| GET | `/api/rooms/{roomId}/spend-pricing` | room |
| POST | `/api/rooms/{roomId}/spend-pricing` | room (privileged — sets per-tool prices) |

## squads.mjs (99 lines)

Squad (sub-team) management — the HTTP twin of the MCP squad tools:

| Method | Path | Auth |
|---|---|---|
| GET | `/api/rooms/{roomId}/squads` | room |
| POST | `/api/rooms/{roomId}/squads` | room (caller becomes owner; ≤12 members) |
| GET | `/api/rooms/{roomId}/squads/{squadId}` | room |
| POST | `/api/rooms/{roomId}/squads/{squadId}/members` | room (owner adds/removes others; members may remove themselves; owner can't be removed from active squad) |
| POST | `/api/rooms/{roomId}/squads/{squadId}/disband` | room (owner only) |

`@squad/<name>` mentions fan out to every active member.

## table.mjs (114 lines)

Aggregation + validation: `ROUTES` (all `*_ROUTES` concatenated, frozen),
`assertRouteRow(row)`, `AUTH_CLASSES`, `ROUTE_SCOPES`, `ROUTE_METHODS`.
The single source the OpenAPI gate and the dispatcher agree on. Includes
`PR_WEBHOOK_ROUTES` (GitHub PR webhook receiver — claim autolink).

## typing.mjs (44 lines)

`postTypingBeat(ctx)` + `TYPING_ROUTES`: `POST
/api/rooms/{roomId}/typing` (auth `room`) — ephemeral typing presence.
`{active: boolean}`; beats expire server-side.

## wake-status.mjs (86 lines)

`authenticateWakeStatus(ctx)` (agent-credential auth, reusing
agent-plugin-routes factories), `readWakeStatus` + `WAKE_STATUS_ROUTES`:
`GET /api/wake-status` (auth `bearer`) — own wakeability, or `?roomId=`
for that room's wakeable vs not-wakeable member lists (caller must be a
member). "Wakeable" = polled or heartbeated within 24h.

## wants-work.mjs (81 lines)

`readOwnWantsWork`, `putOwnWantsWork`, `deleteOwnWantsWork` +
`WANTS_WORK_ROUTES` (GET/PUT/DELETE on the member's wants-work path, auth
`room`). Opt-in "notify me about ready work" feed (BOARD-WAKE-2 consumer).

## work-claims.mjs (110 lines)

Legacy/compat work-claim rows + retention dashboard, complementing
server/work-claim-routes.mjs (the full board implementation):

| Method | Path | Handler |
|---|---|---|
| GET | `/api/rooms/{roomId}/work-claims-read` | `getWorkClaimsRead` (compat read) |
| POST | `/api/rooms/{roomId}/work-claims/{claimId}/close` | `closeRoute` |
| POST | `/api/rooms/{roomId}/work-claims/{claimId}/cancel` | `closeRoute` (verb=cancel) |
| GET | `/api/rooms/{roomId}/work-claims/{claimId}/provenance` | `provenanceRoute` (walks parentClaimId graph) |
| GET | `/api/rooms/{roomId}/work-claims/retention` | `getRetentionDashboard` |

Note: `/api/rooms/{roomId}/work-claims/{claimId}/provenance` is the HTTP
twin of the MCP `room_work_claim_provenance` tool.
