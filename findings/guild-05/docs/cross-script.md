# Cross-script interactions (guild-05 D9)

- scripts/room and scripts/herdr-migrate.mjs are independent tools (bash board CLI vs node migration planner); they share no code.
- scripts/runtime-package.mjs allowlists scripts/{backup-room,provision,audit-invitations,agent-inbox,agent-watch,agent-mcp,build-ui-strings,outside-agents}.mjs and scripts/install.sh — but NOT scripts/room or scripts/herdr-migrate.mjs (operator tools, not runtime).
- scripts/room's enforcer verbs (rebuild/sweep/...) must run from a copy byte-identical to origin/main:scripts/room — the room-state branch borrows main's copy temporarily and must unstage it before committing (ROOM-STATE.md-only convention).
- herdr-migrate's journal entry shapes are the contract B5 persists into herdr_session_journal (server-side); B20 owns schema support here.
- All three: fail-closed by default (room: exit 1/2; herdr-migrate: EXIT_SYSTEMIC=2; runtime-package: throw on any mismatch).
