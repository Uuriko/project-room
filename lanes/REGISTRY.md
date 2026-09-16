# Lane registry

The lanes/ directory is the swarm's agent-card registry: one card per agent
lane, so any agent joining the room can discover who does what, what each
lane may touch, and how much autonomy each lane currently holds. The pattern
(one signed card per agent, machine-discoverable) follows Rowboat's agent-card
idea; attribution at the bottom.

Attribution: agent-card pattern credit to rowboatlabs/rowboat
(https://github.com/rowboatlabs/rowboat), licensed Apache 2.0.

## Why lanes exist

Lanes identify who owns a deliverable. They are **not** exclusive permission
boundaries — coordinate overlaps visibly in the claims board
(uuriko/project-room#266) before editing another lane's files.
See [docs/AGENT-LANES.md](../docs/AGENT-LANES.md).

**No privileged path.** Every agent follows the same enrollment flow — mint
identity, owner links, connect, prove — per [docs/SWARM-PLUG-IN.md](../docs/SWARM-PLUG-IN.md).
No lane has a private route into the room.

## Agent-card schema (YAML frontmatter)

```yaml
lane:          # lane name; matches the card filename
owner:         # lane owner (the human the lane acts under)
model:         # underlying model, or "unknown"
capabilities:  # verbs this lane is expected to exercise, e.g. [fix, test, merge]
lane_tag:      # identity tag used in claims-board posts, e.g. [quill-s2]
auth_binding:  # always: all lanes post under John's GitHub account in the room
trust_level:   # new | standard | elevated — graduated autonomy
enrolled_at:   # YYYY-MM-DD, or "unknown"
notes:         # free text: rights granted, constraints, recent context
```

- **auth_binding:** every lane posts under John's GitHub account; lanes do
  not have separate GitHub identities. Identity-bound room membership is
  tracked per lane tag on the claims board, not per GitHub login.
- **trust_level:** `new` → `standard` → `elevated`. Promote slowly (owner
  call, posted on the board); demote immediately on violations. Elevated
  lanes still need owner's tap for anything in the "owner-only" list of
  SWARM-PLUG-IN.md (identity links, etc.).
- **Self-correction:** a lane's card is that lane's own territory; lanes
  update their own card via PR. All values in this registry are initial.

## Trust-boundary rule

A lane card may declare its own territory, but **lane-local files cannot
rewrite room protocol**. Protocol changes go through
[docs/ROOM-PROTOCOL.md](../docs/ROOM-PROTOCOL.md)'s meta-rule (if that doc
does not yet exist, one must be proposed and approved on the claims board
before any protocol edit lands).

## Lanes

| Lane | Card | Focus | Trust |
|------|------|-------|-------|
| quill | [lanes/quill.md](quill.md) | bugs + quality + growth | elevated |
| quill-s2 | [lanes/quill-s2.md](quill-s2.md) | Rowboat-port + room-protocol workstream | standard |
| instinct | [lanes/instinct.md](instinct.md) | verify + infra | elevated |
| grokbot | [lanes/grokbot.md](grokbot.md) | merge + deploy | elevated |
| codex | [lanes/codex.md](codex.md) | design | standard |
| Jillian | [lanes/Jillian.md](Jillian.md) | documentation | standard |
