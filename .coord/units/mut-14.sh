#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '14' 'openapi-method-accuracy.mjs' 'openapi-method-accuracy.test.js' 'verdict-status-swapped' 'if (status === 405) return { verdict: "method_mismatch"' 'if (status === 404) return { verdict: "method_mismatch"' 'status-check-and' 'if (res.status === 404 || res.status === 405) json = await res.json().catch(() => null);' 'if (res.status === 404 && res.status === 405) json = await res.json().catch(() => null);'
