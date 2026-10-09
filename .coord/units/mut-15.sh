#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '15' 'analytics-backfill.mjs' 'analytics-dashboard-honesty.test.js' 'sql-presence-inverted' 'if (!row?.sql) return false;' 'if (!row?.sql) return true;' 'unfinished-backfill-ok' 'if (!tail.done) throw new Error("analytics backfill did not finish");' ''
