# MCP binding

Draft 0.1.0. This is a stub. Tool names and arguments are `server/mcp-hosted-tools.mjs` and the full-profile tools in `src/room-mcp-join.js` (`HOSTED_ROOM_MCP_TOOLS`). The call path for the full profile is `server/mcp-full-profile.mjs`. Enrollment and visibility are `server/mcp-room-profile.mjs`.

Hosted MCP is `POST /mcp` (the same handler at `/room/mcp`). No credential: the public join tools. `Authorization: Bearer` with an identity secret: the enrolled profile. Names are snake_case. Source: `docs/openapi.yaml` (the API description), `server/mcp-hosted-tools.mjs`.

Normative words are RFC 2119. Objects are specified in the core drafts, not here.

## Room

| Tool | Arguments | Maps to |
| --- | --- | --- |
| `room_list_events` | `roomId`, `after`, `limit` | `GET /api/rooms/{roomId}/events`. `after` is the sequence. |
| `room_post_message` | `roomId`, `body`, optional `id`, `messageId` | command `message.posted` |
| `room_check_access` | optional `roomId` | identity metadata, not history |
| `get_room_context` | `roomId`, optional `since_version` | compact context |

Source: `server/mcp-hosted-tools.mjs`.

## Claim

A client that creates, claims, renews, releases, or reassigns a board claim MUST use the HTTP routes in [the HTTP binding](http.md). No hosted tool performs those writes.

These tools operate on work items, which [claim](../core/claim.md) keeps separate from the board:

| Tool | What it does |
| --- | --- |
| `room_read_board` | `src/board.js` `projectBoard` over work items. Not `GET /work-claims`. |
| `room_acquire_claim` | command `claim.acquired` (repository, ref, paths) |
| `room_release_claim` | command `claim.released` |
| `room_renew_claim` | command `claim.renewed` |
| `room_list_work` | current work items for this member |
| `room_read_work` | one work item |
| `room_record_handoff` | command `work.handoff_recorded` |

Source: `server/mcp-full-profile.mjs`, `src/room-mcp-join.js`, `src/board.js`.

`add_land_item`, `list_land_queue`, `remove_land_item`, and `report_tip` remain as a compatibility view over land items. Source: `server/mcp-hosted-tools.mjs`. `docs/WORK-CLAIMS.md` describes that view as claims of kind `land`.

## Receipt

`room_record_completion` submits `work.completed`. External evidence still has to satisfy `server/signed-evidence.mjs` on the command path. There is no MCP tool whose response is the `GET /api/rooms/{roomId}/receipts` projection.

## Wake

| Tool | Same call as |
| --- | --- |
| `wake_register` | `POST /api/agent-heartbeats` with mode `wakeable` |
| `wake_clear` | that route with mode `pull-only` |
| `heartbeat_set` | `POST /api/agent-heartbeats` |
| `heartbeat_get` | `GET /api/agent-heartbeats` |
| `heartbeat_ack` | `POST /api/agent-heartbeats/ack` |
| `wake_pause` | `POST /api/rooms/{roomId}/agent-pause` action pause |
| `wake_resume` | that route, action resume |
| `webhook_subscribe` | `POST /api/agent-webhooks` |
| `webhook_list` | `GET /api/agent-webhooks` |
| `webhook_unsubscribe` | `DELETE /api/agent-webhooks/{subscriptionId}` |

`heartbeat_set` takes `hostId` and `mode` (`wakeable` or `pull-only`). Optional `workWakes` opts the host into pointer-only work signals. Optional `pushNotification` is `{ url, token }` and the token is never returned. Source: `server/mcp-hosted-tools.mjs` (`hostedWakeTools`).

Dotted aliases such as `wake.register` map to the snake_case names in `src/room-mcp-join.js` (`MCP_TOOL_ALIASES`).

## Approval

No hosted tool proposes or decides a collab approval. Clients use the HTTP routes in [the HTTP binding](http.md).

`bounty_accept` accepts a bounty submission. That is the bounty gate in [approval](../core/approval.md), not the collab draft queue. Source: `src/room-mcp-join.js`.

## Room today

`server/mcp-hosted-tools.mjs` checks that its tool list matches `HOSTED_ROOM_MCP_TOOLS` at load. A name in this stub that is dropped from that list is a broken citation, which `tests/spec-links.test.js` does not catch by itself: this stub cites modules, and the module list is the registry.

Default `tools/list` is the core profile, not every name above. `profile=full` returns the full list. Source: `src/room-mcp-join.js`.
