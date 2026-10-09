#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/fuzz-unit.sh" '14' 'journey-coverage.mjs'
