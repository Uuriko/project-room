import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phaseAPreflight } from '../scripts/phase-a-preflight.mjs';

test('phase A preflight passes the real production wrangler stub', () => {
  const result = phaseAPreflight();
  assert.deepEqual(result, { ok: true, ship: false, persistence: 'none', origin: 'https://room.trydemigod.com' });
});

test('phase A preflight rejects a wrangler file that embeds secrets or live object id', t => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const poisoned = join(dir, 'wrangler.jsonc');
  writeFileSync(poisoned, '{ "vars": { "ROOM_PRODUCTION": "1", "ROOM_CLERK_PUBLISHABLE_KEY": "pk_live_SECRET" } }');
  assert.throws(() => phaseAPreflight({ wranglerPath: poisoned }), /must not contain Clerk secrets/);
  writeFileSync(poisoned, '{ "vars": { "ROOM_PRODUCTION": "1", "ROOM_ORIGIN": "https://room.trydemigod.com" }, "name": "a5f2dca" }');
  assert.throws(() => phaseAPreflight({ wranglerPath: poisoned }), /a5f2dca/);
});
