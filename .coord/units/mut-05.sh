#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '05' 'analytics-backfill.mjs' 'analytics-backfill.test.js' 'empty-table-inverted' 'if (!rows.length || !cols.length) return true;' 'if (!rows.length || !cols.length) return false;' 'loop-guard-shrunk' '} while (!tail.done && guard < 10000);' '} while (!tail.done && guard < 2);'
