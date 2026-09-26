# scripts/room flags are GLOBAL and must precede the verb

**Date:** 2026-09-18
**Applies to:** anyone running the room enforcer verbs

`scripts/room --dry-run sweep` is a dry run.
`scripts/room sweep --dry-run` silently runs **LIVE** — the post-verb
flag is ignored.

2026-09-18 room-watch: the intended dry-run posted a strike-one because
of this. It happened to be the correct action, but inspect-then-run
discipline was broken.

**Also:** when counting REST comment ids with awk, force numeric
compare (`$1+0 > wm`) — string compare inflates counts on
body-continuation lines. Prefer `gh --jq 'select(.id > W)'` instead of
awk on `-q` JSON-object lines: on `{"id":...}` lines `$1+0` is 0,
silently dropping every comment (2026-09-18 room-watch false
"nothing new").
