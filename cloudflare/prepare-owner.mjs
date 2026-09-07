import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = new URL('./.operator/', import.meta.url);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const key = randomBytes(32).toString('base64url');
const ownerFile = new URL('owner-key.txt', directory);
writeFileSync(ownerFile, key + '\n', { mode: 0o600, flag: 'wx' });
writeFileSync(new URL('bootstrap.json', directory), JSON.stringify({
  ROOM_BOOTSTRAP_OWNER_HASH: createHash('sha256').update(key).digest('hex'),
  ROOM_BOOTSTRAP_EXPIRES_AT: String(Date.now() + 7 * 86400000 - 60000)
}, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Owner key saved privately:', fileURLToPath(ownerFile));
console.log('Bootstrap metadata saved privately; no key has been printed or published.');
