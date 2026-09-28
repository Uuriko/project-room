import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const room = fileURLToPath(new URL('../scripts/room', import.meta.url));
const comments = JSON.stringify([{ id: 1, created_at: '2026-09-24T00:00:00Z', body: `[quill][claim]\n\`\`\`room-claim\ntask-id: RC-2026-09-24-001\nlane: quill\nfiles: scripts/a.mjs\nlease: lease=6h\nstate: working\nreason: testing\n\`\`\`` }]);

test('posting verbs accept post-verb dry-run and never call GitHub POST', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-verb-dry-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const log = join(dir, 'gh.log'); writeFileSync(log, '');
    const source = join(dir, 'comments.json'); writeFileSync(source, comments);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
printf '%s\n' "$*" >> "$GH_LOG"
case "$*" in
  *rate_limit*) printf 'HTTP/2 200\nDate: Thu, 24 Sep 2026 01:40:00 GMT\n\n{}\n' ;;
  *comments*) cat "$GH_COMMENTS" ;;
  *pulls*) printf '[]\n' ;;
  *) printf '{}\n' ;;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const env = { ...process.env, GH_LOG: log, GH_COMMENTS: source, ROOM_ENFORCER_ALLOW_STALE: '1', PATH: `${bin}:${process.env.PATH}` };
    const cases = [
      ['heartbeat', '--task-id', 'RC-2026-09-24-001', '--lane', 'quill', '--dry-run'],
      ['release', '--task-id', 'RC-2026-09-24-001', '--lane', 'quill', '--reason', 'test', '--dry-run'],
      ['handoff', '--task-id', 'RC-2026-09-24-001', '--from', 'quill', '--to', 'grok', '--context', 'test', '--dry-run'],
      ['receipt', '--task-id', 'RC-2026-09-24-001', '--lane', 'quill', '--merged', 'none', '--note', 'test', '--dry-run'],
      ['receipts-scan', '--post', '--dry-run'],
    ];
    for (const args of cases) {
      writeFileSync(log, '');
      const result = spawnSync('bash', [room, ...args], { encoding: 'utf8', env, timeout: 10000 });
      assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
      assert.ok(result.stdout.length, `${args[0]} has dry-run output`);
      assert.doesNotMatch(readFileSync(log, 'utf8'), /-X POST|--method POST/, `${args[0]} posted`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
