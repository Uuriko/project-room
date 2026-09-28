import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const room = fileURLToPath(new URL('../scripts/room', import.meta.url));

test('metrics --since with invalid timestamp exits 1 and validates before fetch_comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-metrics-invalid-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'gh.log');
    writeFileSync(log, '');
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
exit 0
`
    );
    chmodSync(join(bin, 'gh'), 0o755);

    const env = {
      ...process.env,
      GH_LOG: log,
      ROOM_ENFORCER_ALLOW_STALE: '1',
      PATH: `${bin}:${process.env.PATH}`,
    };

    const result = spawnSync('bash', [room, 'metrics', '--since', 'garbage'], { encoding: 'utf8', env });
    assert.equal(result.status, 1, `status was ${result.status}: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('room: error: metrics: invalid --since timestamp: garbage'),
      `stderr did not contain expected message: ${result.stderr}`
    );
    assert.equal(readFileSync(log, 'utf8'), '', 'mock gh was called, validation did not happen before fetch_comments');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics --since with timezone offset produces identical results to equivalent Z time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-metrics-offset-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'gh.log');
    writeFileSync(log, '');
    const comments = [
      { id: 1, created_at: '2026-09-23T10:00:00Z', body: 'before the window' },
      { id: 2, created_at: '2026-09-23T14:00:00Z', body: '[quill][claim] RC-2026-09-23-001 inside window 1. Exact files: `a.mjs`' },
      { id: 3, created_at: '2026-09-23T18:00:00Z', body: '[quill][claim] RC-2026-09-23-002 inside window 2. Exact files: `b.mjs`' },
    ];
    const source = join(dir, 'comments.json');
    writeFileSync(source, JSON.stringify(comments));

    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  *rate_limit*) printf 'HTTP/2 200\\nDate: Thu, 24 Sep 2026 01:40:00 GMT\\n\\n{}\\n' ;;
  *comments*) cat "$GH_COMMENTS" ;;
  *) printf '{}\\n' ;;
esac
`
    );
    chmodSync(join(bin, 'gh'), 0o755);

    const env = {
      ...process.env,
      GH_LOG: log,
      GH_COMMENTS: source,
      ROOM_ENFORCER_ALLOW_STALE: '1',
      PATH: `${bin}:${process.env.PATH}`,
    };

    const resA = spawnSync('bash', [room, 'metrics', '--since', '2026-09-23T12:00:00Z'], { encoding: 'utf8', env });
    const resB = spawnSync('bash', [room, 'metrics', '--since', '2026-09-23T16:00:00+04:00'], { encoding: 'utf8', env });

    assert.equal(resA.status, 0, `Command A failed: ${resA.stderr}`);
    assert.equal(resB.status, 0, `Command B failed: ${resB.stderr}`);
    assert.equal(resA.stdout, resB.stdout, 'Outputs differed between UTC and equivalent offset timestamps');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
