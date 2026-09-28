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

    for (const since of ['garbage', '2026-02-30T12:00:00Z', '2026-02-29',
      '2026-09-23T12:00:00+24:00', '2026-09-23T12:00:00-07:60', '2026-09-23T12:00:00+99:99']) {
      writeFileSync(log, '');
      const result = spawnSync('bash', [room, 'metrics', '--since', since], { encoding: 'utf8', env, timeout: 10000 });
      assert.equal(result.status, 1, `${since}: ${result.stderr}`);
      assert.ok(result.stderr.includes(`room: error: metrics: invalid --since timestamp: ${since}`), result.stderr);
      assert.equal(readFileSync(log, 'utf8'), '', `${since}: invalid input contacted the board`);
    }
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

    const run = since => spawnSync('bash', [room, 'metrics', '--since', since], { encoding: 'utf8', env, timeout: 10000 });
    const utc = run('2026-09-23T12:00:00Z');
    assert.equal(utc.status, 0, utc.stderr);
    assert.match(utc.stdout, /^claims_opened=2$/m);
    assert.match(utc.stdout, /^comments_per_day=2\.00$/m);
    for (const since of ['2026-09-23T16:00:00+04:00', '2026-09-23T05:00:00-0700']) {
      const result = run(since);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, utc.stdout, since);
    }
    for (const since of ['2026-09-23', '2026-09-23T00:00:00Z', '2024-02-29']) {
      const result = run(since);
      assert.equal(result.status, 0, `${since}: ${result.stderr}`);
      assert.match(result.stdout, /^claims_opened=2$/m);
      assert.match(result.stdout, /^comments_per_day=3\.00$/m);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
