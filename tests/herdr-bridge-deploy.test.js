import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSocketDir } from '../bridge/lib/tenants.mjs';

const read = (p) => readFileSync(new URL(`../bridge/${p}`, import.meta.url), 'utf8');

test('tenant unit uses the shared-group socket model', () => {
  const unit = read('deploy/herdr@.service');
  assert.match(unit, /^UMask=0007$/m);
  assert.match(unit, /install -d -m 2750 -o %i -g herdr-bridge \/run\/herdr\/%i/);
  assert.doesNotMatch(unit, /-m 0700 -o %i -g %i \/run\/herdr/, 'a 0700 dir locks the bridge user out');
});

test('bridge unit keeps NoNewPrivileges and promises no sudo path', () => {
  const unit = read('deploy/herdr-bridge.service');
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.doesNotMatch(unit, /^[^#\n]*sudo/m);
  const src = read('lib/bridge.mjs') + read('herdr-bridge.mjs');
  assert.doesNotMatch(src, /child_process|systemctl|ALLOW_SYSTEMCTL/);
});

test('tmpfiles creates the socket parent traversable but not listable', () => {
  assert.match(read('deploy/herdr-tmpfiles.conf'), /^d \/run\/herdr 0711 root root -$/m);
});

test('checkSocketDir accepts 750 dir + 660 socket, flags world access and a 700 dir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-sock-'));
  const dir = join(root, 't1');
  mkdirSync(dir);
  const sock = join(dir, 'herdr.sock');
  writeFileSync(sock, '');
  chmodSync(dir, 0o750); chmodSync(sock, 0o660);
  assert.deepEqual(await checkSocketDir({ socketPath: sock }), []);
  chmodSync(dir, 0o700);
  assert.match((await checkSocketDir({ socketPath: sock })).join('\n'), /want 750/);
  chmodSync(dir, 0o750); chmodSync(sock, 0o666);
  assert.match((await checkSocketDir({ socketPath: sock })).join('\n'), /want 660/);
});
