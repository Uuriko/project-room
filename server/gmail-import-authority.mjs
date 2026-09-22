// A process-local, unforgeable capability for importing a connected owner's
// Gmail observations. Never serialized, never accepted from HTTP, never a session.
import { ServiceError } from './store.mjs';
const grants = new WeakMap();
export function gmailImportToken(store, accountId, connectionId, check) {
  const token = Object.freeze({});
  grants.set(token, { store, accountId, connectionId, epoch: store.account(accountId).authEpoch, check });
  return token;
}
export function gmailImportAuth(store, token, request) {
  const grant = token && typeof token === 'object' ? grants.get(token) : null;
  if (!grant) return null;
  const reject = () => { throw new ServiceError(403, 'gmail_import_authority', 'Gmail import authority expired.'); };
  if (grant.store !== store) reject();
  grant.check();
  const account = store.account(grant.accountId), connection = store.connections.connection(account.id, grant.connectionId);
  if (!account.active || account.authEpoch !== grant.epoch || connection?.state !== 'active' || connection.authEpoch !== grant.epoch || connection.profile.provider !== 'gmail-api') reject();
  if (request.action === 'page.apply') { if (request.connectionId !== grant.connectionId) reject(); }
  else if (request.action === 'source.import') {
    if (request.data?.envelope?.connection?.id !== grant.connectionId || request.data.envelope.connection.accountId !== account.id) reject();
  } else reject();
  return { account, sessionBinding: null, sessionRevision: 0 };
}
