import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { GmailOAuth, GMAIL_CALLBACK_PATH } from './gmail-oauth.mjs';
import { MailCredentialVault } from './mail-credential-vault.mjs';
import { GmailConnections } from './gmail-connections.mjs';

const names = ['ROOM_GMAIL_CLIENT_FILE', 'ROOM_GMAIL_KEY_FILE', 'ROOM_GMAIL_VAULT_FILE'];
const fail = () => { const error = new Error('Gmail private configuration is invalid'); error.code = 'gmail_private_configuration_invalid'; throw error; };
const outside = (root, path) => { const rel = relative(root, path); return rel === '..' || rel.startsWith('../') || isAbsolute(rel); };
function privateFile(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > limit) fail();
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

// Opt-in factory only. Does not create a key, consent grant, or network request.
// The main server must own close() and keep this database out of room backups.
export function createGmailRuntime({ env = process.env, origin, store,
  sourceRoot = fileURLToPath(new URL('../', import.meta.url)) }) {
  if (names.every(name => !env[name])) return null;
  let db, vault, key;
  try {
    if (names.some(name => !env[name] || !isAbsolute(env[name]))) fail();
    const paths = names.map(name => resolve(env[name]));
    if (new Set(paths).size !== 3) fail();
    const root = realpathSync(sourceRoot);
    for (const path of paths) {
      const parent = realpathSync(dirname(path));
      if (!outside(root, parent) || parent !== dirname(path)) fail();
    }
    const [clientPath, keyPath, vaultPath] = paths;
    const parent = lstatSync(dirname(vaultPath));
    if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o077) fail();
    try {
      const stat = lstatSync(vaultPath);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077) fail();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const client = JSON.parse(privateFile(clientPath, 16384).toString('utf8')).web;
    const redirectUri = origin + GMAIL_CALLBACK_PATH;
    if (!client?.redirect_uris?.includes(redirectUri)) fail();
    key = privateFile(keyPath, 32);
    if (key.length !== 32) fail();
    const oauth = new GmailOAuth({ clientId: client.client_id, clientSecret: client.client_secret,
      redirectUri, now: () => store.now() });
    // Refuse an existing room database: credentials must never join its export path.
    if (lstatSync(dirname(vaultPath)).mode & 0o077) fail();
    const previousMask = process.umask(0o077);
    try { db = new DatabaseSync(vaultPath); } finally { process.umask(previousMask); }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('mail_credentials_v1') LIMIT 1").get()) fail();
    vault = new MailCredentialVault({ db, key });
    const connections = new GmailConnections({ store, vault, oauth });
    let closed = false;
    return { connections, close() { if (!closed) { closed = true; vault.close(); db.close(); } } };
  } catch {
    vault?.close(); db?.close(); fail();
  } finally { key?.fill(0); }
}
