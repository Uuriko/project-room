// Explicit local-only provisioning. Refuses an existing destination; prints no keys.
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

const directory = process.argv[2];
if (!directory || !isAbsolute(directory)) throw new Error('Supply a new absolute private directory');
process.umask(0o077);
mkdirSync(directory, { mode: 0o700 });
if (realpathSync(directory) !== directory) throw new Error('Use a canonical directory');
const store = new RoomStore(join(directory, 'room.sqlite'));
try {
  store.initialize(initialRoom());
  const roomKey = store.issueAccessKey('commons', 'owner');
  store.revoke(roomKey);
  const account = store.accountForMember('commons', 'owner');
  const key = store.issueAccountAccessKey(account.id);
  writeFileSync(join(directory, 'account-key'), key + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'vault.key'), randomBytes(32), { flag: 'wx', mode: 0o600 });
  console.log('Private local pilot initialized. Account key and encryption key saved privately; no mailbox access requested.');
} finally { store.close(); }
