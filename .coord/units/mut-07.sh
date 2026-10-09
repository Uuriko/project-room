#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '07' 'backup-verify.mjs' 'backup-verify.test.js' 'zero-interval-allowed' 'if (!Number.isSafeInteger(n) || n < 1) throw new Error(`invalid schedule: ${spec}`);' 'if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid schedule: ${spec}`);' 'cron-arity-6' 'if (fields.length === 5) {' 'if (fields.length === 6) {'
