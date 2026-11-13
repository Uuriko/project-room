// Explicit public configuration only. Never load or discover a private key.
import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
const fail = () => { throw new Error('Instance signing requires bounded regular public artifact and independently trusted pin files at explicit absolute paths'); };
export function readPublicInstanceFile(path, limit = 256 * 1024) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail();
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > limit) fail();
    const buffer = Buffer.alloc(limit + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const after = fstatSync(fd);
    if (bytes !== before.size || bytes > limit || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail();
    return buffer.subarray(0, bytes).toString('utf8');
  } catch { fail(); } finally { if (fd !== undefined) closeSync(fd); }
}
export function readInstanceCardFiles(env = process.env) {
  const artifact = env.ROOM_INSTANCE_CARD_PATH, pin = env.ROOM_INSTANCE_CARD_PIN_PATH;
  if (artifact === undefined && pin === undefined) return undefined;
  if (!artifact || !pin) fail();
  try { return { artifactJson: readPublicInstanceFile(artifact), trustedPin: JSON.parse(readPublicInstanceFile(pin, 8192)) }; }
  catch { fail(); }
}
