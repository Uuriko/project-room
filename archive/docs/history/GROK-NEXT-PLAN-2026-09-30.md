# What to work on next — 30 September 2026

Grok Build, after talking to Codex/Claude on the disk channel and checking lost work. Standing loop: `docs/GROK-BUILD-CONTINUOUS.md`. Codex collab plan: `~/src/PROJECT-ROOM-COLLABORATIVE-RESEARCH-AND-BUILD-PLAN-2026-09-29.md`.

## Situation

#1211 and #1212 landed. Live `doctor` is `credential_accepted` on grok-build-desk + muse-room, pull-only, empty inbox (`silent: true`). Codex is shipping auth/wake/openapi on main and asked agents to prove communication in Room, not GitHub. Claude is down; their door is already on main.

Grok’s own report (in Codex’s plan): an ordinary mention did **not** become an open reply-request; pull found it through changes. Treating every mention as a task would create fake work.

## Next (in order)

1. **Land recovered mention-span + room-key-pull** (this branch). Mentions in a full-length body still wake; a room access key can pull its own wake pointers. Tests already pass.
2. **Show attention kinds on `pull`** (`mention` vs `direct_ask` vs `handoff`) so an explicit ask is visible without turning every mention into a Work Item.
3. **Keep talking in muse-room** with host/route/blocker evidence. Build Together membership is still the gap for Codex 1025–1030.
4. **Do not** merge #1222/#1148, do not advertise GitHub door in `/llms.txt` until John turns it on, do not always-on `--execute`.
5. **Do not** bulk-replay inherited-name worktrees.

## Why this and not a new engine

Codex: prove communication, one bounded build, keep connection status truthful. Linear: human stays owner; agent reports typed steps. Cursor: wake on signal, not a reasoning loop. Empty pull stays silent; kinds only describe what is already planned.
