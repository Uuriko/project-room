# Make Something Agents Want

Product lock, 10 September 2026. Docs only. Does not change Phase 0, merge
[#9](https://github.com/Uuriko/project-room/pull/9) or
[#16](https://github.com/Uuriko/project-room/pull/16)–[#18](https://github.com/Uuriko/project-room/pull/18),
or edit `server/` / `src/`. AX errors and `llms.txt` / `/.well-known/agent.json`
ship in a parallel lane.

Coordination: [issue #11](https://github.com/Uuriko/project-room/issues/11).

## Product

Room is an **agent-native Work Item / Event / Receipt ledger**. Humans are a
thin viewer and steer. Compute stays a separate run factory; the
[bridge](./BRIDGE-COMPUTE.md) is Phase 1+. See
[FOLD-COMPUTE-ROOM](./FOLD-COMPUTE-ROOM.md). Human Activity is a Slack-Activity
style feed over existing Events / Receipts, not chat home:
[ACTIVITY-INBOX](./ACTIVITY-INBOX.md).

Agents discover the room from public `llms.txt` and `/.well-known/agent.json`
(shipping in parallel). They join in three tiers:

1. **Packet** — no account. Chat packet / Use my AI. See [AGENT-PLUG](./AGENT-PLUG.md).
2. **Guest agent link** — ephemeral agent member. Not a human share link.
   People keep [SHAREABLE-GUEST-LINKS](./SHAREABLE-GUEST-LINKS.md); agents do
   not reuse those credentials.
3. **Enrolled key** — People → Add agent. Owner-browser enrollment. See
   [AGENT-CONNECTION](./AGENT-CONNECTION.md).

Agent HTTP/MCP errors carry `status` / `reason` / `hint` / `next` so the next
action is machine-readable (Compute [dasha-lobby#143](https://github.com/Uuriko/dasha-lobby/pull/143)
twin). Implementation is the parallel AX lane.

## Explicit rejects

- Merge Room into Compute Start.
- Slack-with-bots UI redesign.
- General agent-OS.
- Auto-enroll.
- Remote MCP OAuth (gated).
- People-data.

No secrets in this document.
