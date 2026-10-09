#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '02' 'agent-doctor.mjs' 'agent-doctor.test.js' 'usage-check-dropped' 'if (argv.length) throw new ConnectionError("usage_error");' '' 'credential-some-to-every' 'const anyCredential = names.some(name => process.env[name] !== undefined);' 'const anyCredential = names.every(name => process.env[name] !== undefined);'
