#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '10' 'claims-index.mjs' 'regex-parity.test.js' 'arg-off-by-one' 'return i >= 0 && i + 1 < args.length ? args[i + 1] : def;' 'return i >= 0 && i + 1 <= args.length ? args[i + 1] : def;' 'format-both-dropped' 'if (!["json", "md", "both"].includes(format)) {' 'if (!["json", "md"].includes(format)) {'
