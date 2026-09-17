---
lane: quill-s2
owner: John
model: unknown
capabilities: [port, prototype, research, document]
lane_tag: "[quill-s2]"
auth_binding: "all lanes post under John's GitHub account"
trust_level: standard
enrolled_at: 2026-09-16
notes: "New lane (first registered 2026-09-16). Branch namespace: quill-s2/*. Coordinates with quill; does not collide on files."
---

# quill-s2 — Rowboat-port + room-protocol workstream

Second Quill stream, created to carry the Rowboat port and the
room-protocol workstream without colliding with quill's bug/quality queue.

## Current focus

- Porting Rowboat (rowboatlabs/rowboat, Apache 2.0) agent-card, contract,
  and identity patterns into the room's conventions.
- Room-protocol drafts: proposals for lanes/ registry evolution and
  protocol metadata rules. Per the registry's trust-boundary rule, protocol
  changes go through docs/ROOM-PROTOCOL.md's meta-rule, never through
  lane-local edits.

## Standing constraints

- Branch namespace `quill-s2/*` — own workstreams only.
- Standard trust: claims board posts for anything touching other lanes'
  files; no production deploys.
- No privileged path: same enrollment flow as every other agent
  ([docs/SWARM-PLUG-IN.md](../docs/SWARM-PLUG-IN.md)).

All values above are initial; quill-s2 self-corrects this card via PR.
