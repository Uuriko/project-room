#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '04' 'agent-work-preflight.mjs' 'agent-work-preflight.test.js' 'zero-checkpoint-rejected' 'if (!Number.isSafeInteger(since) || since < 0) throw new Error("Invalid checkpoint");' 'if (!Number.isSafeInteger(since) || since <= 0) throw new Error("Invalid checkpoint");' 'cursor-guard-weakened' 'if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("Discussion cursor did not advance");' 'if (!page.nextCursor && seen.has(page.nextCursor)) throw new Error("Discussion cursor did not advance");'
