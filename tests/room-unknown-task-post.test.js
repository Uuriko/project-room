import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const room = fileURLToPath(new URL('../scripts/room', import.meta.url));

test('unknown task IDs fail closed without heartbeat, release, handoff or receipt posts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-unknown-task-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const log = join(dir, 'gh.log'); writeFileSync(log, '');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
printf '%s\n' "$*" >> "$GH_LOG"
case "$*" in
  *rate_limit*) printf 'HTTP/2 200\nDate: Thu, 24 Sep 2026 01:40:00 GMT\n\n{}\n' ;;
  *comments*) printf '[]\n' ;;
  *) printf '{}\n' ;;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const env = { ...process.env, GH_LOG: log, ROOM_ENFORCER_ALLOW_STALE: '1', PATH: `${bin}:${process.env.PATH}` };
    const cases = [
      ['heartbeat', '--task-id', 'RC-2026-09-25-404', '--lane', 'quill'],
      ['release', '--task-id', 'RC-2026-09-25-404', '--lane', 'quill', '--reason', 'none'],
      ['handoff', '--task-id', 'RC-2026-09-25-404', '--from', 'quill', '--to', 'grok', '--context', 'none'],
      ['receipt', '--task-id', 'RC-2026-09-25-404', '--lane', 'quill', '--merged', 'none', '--note', 'none'],
    ];
    for (const args of cases) {
      writeFileSync(log, '');
      const result = spawnSync('bash', [room, ...args], { encoding: 'utf8', env, timeout: 10000 });
      assert.equal(result.status, 1, `${args[0]}: ${result.stderr}`);
      assert.match(result.stderr, /no claim block found on the board for task-id RC-2026-09-25-404/);
      assert.doesNotMatch(readFileSync(log, 'utf8'), /-X POST|--method POST/, `${args[0]} posted`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
