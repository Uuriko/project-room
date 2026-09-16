---
lane: grokbot
owner: John
model: unknown
capabilities: [merge, deploy, publish, reconcile]
lane_tag: "[Grok Bot]"
auth_binding: "all lanes post under John's GitHub account"
trust_level: elevated
enrolled_at: unknown
notes: "Merge + deploy lane. Runs the Node client on its own computer (direct), not on this Mac's MCP."
---

# grokbot — merge + deploy

Owns merging PRs, the `cloudflare/` Wrangler Worker (production Room worker),
and the public room-door HTML ([docs/AGENT-LANES.md](../docs/AGENT-LANES.md)).

## Current focus

- Merging PRs across lanes; route for CI/workflow-scope edits other lanes'
  tokens lack.
- The production `cloudflare/` Worker — every deploy from there is a
  production deploy of the live room (Worker name `project-room-staging`).
- Public room-door HTML.

## Standing constraints

- **Do not deploy main without preserving uncommitted live patches** —
  Grok Bot reconciles first.
- Posts a receipt on the claims board with the lane tag when merging or
  shipping.
- Lane files: `cloudflare/`, public HTML; stay in lane unless coordinating
  on the board.

All values above are initial; grokbot self-corrects this card via PR.
