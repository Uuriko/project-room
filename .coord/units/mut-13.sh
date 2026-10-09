#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '13' 'journey-coverage.mjs' 'journey-coverage.test.js' 'map-version-2' 'if (map.version !== 1 || !Array.isArray(map.claims) || map.claims.length === 0) {' 'if (map.version !== 2 || !Array.isArray(map.claims) || map.claims.length === 0) {' 'dup-detection-inverted' 'if (seen.has(claim.id)) problems.push(`${label}: duplicate claim id`); seen.add(claim.id);' 'if (!seen.has(claim.id)) problems.push(`${label}: duplicate claim id`); seen.add(claim.id);'
