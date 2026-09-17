import { initialRoom } from '../server/bootstrap.mjs';

// Operator-configured, one-time bootstrap. No public administration endpoint,
// no raw owner key on the server, and no resetting an existing workspace.
//
// An invalid or expired window is NOT fatal: the Durable Object constructor
// runs on every cold start, so throwing here would turn a stale one-time
// setting into a Worker that answers every request with a 500 while the rooms
// table is empty. Instead the Worker logs the reason once per isolate and
// serves requests without provisioning; the operator fixes or removes the
// two ROOM_BOOTSTRAP_* settings. Nothing is written in that case.
let warned = false;
export function bootstrapRoom(store, env, { log = console.warn } = {}) {
  if (store.db.prepare('SELECT 1 FROM rooms LIMIT 1').get()) return false;
  if (!env.ROOM_BOOTSTRAP_OWNER_HASH) return false;
  const reason = bootstrapConfigurationProblem(env, store.now());
  if (reason) {
    if (!warned) { warned = true; log(`Operator bootstrap skipped: ${reason}. The workspace stays empty; fix or remove ROOM_BOOTSTRAP_OWNER_HASH and ROOM_BOOTSTRAP_EXPIRES_AT.`); }
    return false;
  }
  const expiresAt = Number(env.ROOM_BOOTSTRAP_EXPIRES_AT);
  return store.transaction(() => {
    store.initialize(initialRoom());
    const account = store.bindHumanAccount('commons', 'owner', 'pilot-owner');
    store.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch) VALUES(?,'commons','owner','access',NULL,?,?,?)")
      .run(env.ROOM_BOOTSTRAP_OWNER_HASH, expiresAt, account.id, account.authEpoch);
    return true;
  });
}

// Returns null when the operator window is usable, otherwise a short reason.
// Values never appear in the reason: the hash is a credential and the expiry
// alone could still help a guesser.
export function bootstrapConfigurationProblem(env, now) {
  if (!/^[a-f0-9]{64}$/.test(env.ROOM_BOOTSTRAP_OWNER_HASH)) return 'ROOM_BOOTSTRAP_OWNER_HASH is not a 64-character lowercase hex SHA-256';
  const raw = String(env.ROOM_BOOTSTRAP_EXPIRES_AT ?? '').trim(), expiresAt = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(expiresAt)) return 'ROOM_BOOTSTRAP_EXPIRES_AT is not an integer Unix-millisecond timestamp';
  if (expiresAt <= now) return 'ROOM_BOOTSTRAP_EXPIRES_AT is in the past';
  if (expiresAt > now + 7 * 86400000) return 'ROOM_BOOTSTRAP_EXPIRES_AT is more than seven days ahead';
  return null;
}

// Test-only: lets the check observe the once-per-isolate log again.
export function resetBootstrapWarning() { warned = false; }
