import { initialRoom } from '../server/bootstrap.mjs';

// Operator-configured, one-time bootstrap. No public administration endpoint,
// no raw owner key on the server, and no resetting an existing workspace.
export function bootstrapRoom(store, env) {
  if (store.db.prepare('SELECT 1 FROM rooms LIMIT 1').get()) return false;
  if (!env.ROOM_BOOTSTRAP_OWNER_HASH) return false;
  const expiresAt = Number(env.ROOM_BOOTSTRAP_EXPIRES_AT);
  if (!/^[a-f0-9]{64}$/.test(env.ROOM_BOOTSTRAP_OWNER_HASH)
    || !Number.isSafeInteger(expiresAt) || expiresAt <= store.now() || expiresAt > store.now() + 7 * 86400000) {
    throw new Error('Invalid or expired operator bootstrap configuration');
  }
  return store.transaction(() => {
    store.initialize(initialRoom());
    const account = store.bindHumanAccount('commons', 'owner', 'pilot-owner');
    store.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch) VALUES(?,'commons','owner','access',NULL,?,?,?)")
      .run(env.ROOM_BOOTSTRAP_OWNER_HASH, expiresAt, account.id, account.authEpoch);
    return true;
  });
}
