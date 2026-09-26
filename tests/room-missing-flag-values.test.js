import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const room = fileURLToPath(new URL('../scripts/room', import.meta.url));

test('value flags fail clearly before a board read or post', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-missing-value-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const log = join(dir, 'calls'); writeFileSync(log, '');
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_LOG"\nexit 1\n');
    chmodSync(join(bin, 'gh'), 0o755);
    const cases = [
      { args: ['claim', '--task-id'], label: 'claim: --task-id' },
      { args: ['heartbeat', '--note'], label: 'heartbeat: --note' },
      { args: ['receipt', '--merged'], label: 'receipt: --merged' },
      { args: ['query', '--state'], label: 'query: --state' },
      { args: ['rebuild', '--out'], label: 'rebuild: --out' },
      { args: ['metrics', '--since'], label: 'metrics: --since' },
      { args: ['--repo'], label: 'global: --repo' },
      { args: ['claim', '--task-id', '--lane', 'x'], label: 'claim: --task-id' },
    ];
    for (const { args, label } of cases) {
      const result = spawnSync('bash', [room, ...args], { encoding: 'utf8',
        env: { ...process.env, GH_LOG: log, ROOM_ENFORCER_ALLOW_STALE: '1', PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
      assert.ok(result.stderr.includes(`${label} needs a value`), result.stderr);
      assert.doesNotMatch(result.stderr, /unbound variable/);
      assert.equal(readFileSync(log, 'utf8'), '', `${args.join(' ')} contacted the board`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
