#!/usr/bin/env bash
set -u
exec "$HOME/workspace/pr-wave1000-guild-06/.coord/mut-unit.sh" '12' 'flaky-detect.mjs' 'flaky-detect.test.js' 'stack-pop-boundary' 'while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();' 'while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop();' 'empty-suite-inverted' 'else if (tests.size === 0) {' 'else if (tests.size !== 0) {'
