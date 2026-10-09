#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '01' 'access-review.mjs' 'access-review.test.js' 'db-origin-conflict-weakened' 'if (values.db && values.origin) throw new Error("Choose --db or --origin, not both");' 'if (values.db || values.origin) throw new Error("Choose --db or --origin, not both");' 'revoke-arity-2' 'if (values.room?.length !== 1) throw new Error("--revoke-identity requires exactly one --room");' 'if (values.room?.length !== 2) throw new Error("--revoke-identity requires exactly one --room");'
