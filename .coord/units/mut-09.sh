#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '09' 'bounty-conservation-check.mjs' 'bounty-conservation-check.test.js' 'report-always-ok' 'ok: violations.length === 0,' 'ok: violations.length >= 0,' 'escrow-branch-inverted' 'if (!hasEscrow) {' 'if (hasEscrow) {'
