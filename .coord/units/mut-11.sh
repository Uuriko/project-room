#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '11' 'dependency-audit.mjs' 'dependency-audit.test.js' 'severity-validation-inverted' 'if (!SEVERITIES.includes(severity)) throw new AuditError(`Unknown severity "${raw}"`);' 'if (SEVERITIES.includes(severity)) throw new AuditError(`Unknown severity "${raw}"`);' 'error-detection-every' '[payload.error.code, payload.error.summary, payload.error.detail].some(Boolean)' '[payload.error.code, payload.error.summary, payload.error.detail].every(Boolean)'
