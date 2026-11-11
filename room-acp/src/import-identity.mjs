// Import an operator-selected existing identity without persisting its global
// bearer. Generic key issuance has no replay contract: unknown means stop.
import { join as pathJoin } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeBase } from './link.mjs';
import { RoomClient } from './room.mjs';
import { configDir, listConnections, saveConnection, loadConnection } from './credentials.mjs';
import { openJoinJournal } from './private-state.mjs';
import { assertPrivatePath, readPrivateJson } from './private-files.mjs';
import { defaultHostId } from './join.mjs';
import { registerSecret } from './redact.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export function readExistingIdentity(directory) {
  try {
    assertPrivatePath(directory, true);
    const value = readPrivateJson(pathJoin(directory, 'connection.json'), 4096);
    registerSecret(value?.token);
    if (value?.version !== 1 || !id(value.memberId) || typeof value.token !== 'string' || !/^pri_[A-Za-z0-9_-]+$/.test(value.token)
      || typeof value.origin !== 'string' || normalizeBase(value.origin) !== value.origin) throw Error('invalid');
    return { apiBase: value.origin, memberId: value.memberId, credential: value.token };
  } catch { throw Error('Select your existing private CLI connection directory with a global identity credential; no key was issued'); }
}

export async function importIdentity({ identityFrom, roomId, agent = null, env = process.env, fetchImpl = fetch }) {
  if (typeof identityFrom !== 'string' || !identityFrom || !id(roomId)) throw Error('Use import-identity --identity-from <private connection directory> --room <exact room ID>');
  const source = readExistingIdentity(identityFrom);
  const global = new RoomClient({ ...source, roomId, fetchImpl });
  const account = await global.request('/api/agent-rooms');
  if (!id(account?.identityId)) throw Error('Existing identity could not be verified; no key was issued');
  const access = await global.checkConnection();
  const member = access.state.members[source.memberId];
  const binding = { apiBase: source.apiBase, roomId, memberId: source.memberId, identityId: account.identityId };
  const key = digest(['import-identity', binding]);
  const journal = openJoinJournal(configDir(env), key);
  let destination;
  try {
    destination = openJoinJournal(configDir(env), 'room-' + digest(roomId.replace(/[^A-Za-z0-9._-]/g, '_')));
    const owner = destination.read();
    if (owner && (owner.version !== 1 || typeof owner.apiBase !== 'string' || typeof owner.roomId !== 'string'
      || owner.operationKey !== null && typeof owner.operationKey !== 'string')) throw Error('Saved destination ownership is invalid');
    if (owner?.operationKey && owner.operationKey !== key) throw Error('An earlier setup for this room has an unresolved outcome; reconcile that operation first');
    let pending = journal.read();
    registerSecret(pending?.connection?.credential);
    if (pending && (pending.version !== 1 || typeof pending.attempted !== 'boolean' || typeof pending.label !== 'string'
      || JSON.stringify(pending.binding) !== JSON.stringify(binding))) throw Error('Existing import receipt does not match this identity');
    const existing = listConnections(env).filter(entry => typeof entry.roomId === 'string' && entry.roomId.replace(/[^A-Za-z0-9._-]/g, '_') === roomId.replace(/[^A-Za-z0-9._-]/g, '_'));
    if (existing.length > 1 || existing.some(entry => entry.roomId !== roomId || entry.apiBase !== source.apiBase || entry.memberId !== source.memberId || entry.identityId !== account.identityId))
      throw Error('Another connection is already saved for this room; no key was issued or connection replaced');
    if (pending?.attempted && !pending.connection && !pending.completed)
      throw Error(`Key issuance outcome is unknown for label ${pending.label}. Do not issue again or delete this receipt; reconcile that exact label using your identity's API-key list`);
    if (existing[0]) {
      await new RoomClient({ ...existing[0], fetchImpl }).checkConnection();
      if (pending?.connection && pending.connection.credential !== existing[0].credential) throw Error('Saved connection differs from this import; reconcile before replacing anything');
      if (pending) { journal.save({ ...pending, completed: true, connection: null }); destination.save({ version: 1, apiBase: source.apiBase, roomId, operationKey: null }); }
      return existing[0];
    }
    if (pending?.completed) throw Error('This imported connection was forgotten; no replacement key was issued');
    if (!pending) {
      pending = { version: 1, binding, label: 'room-acp-import-' + randomUUID(), hostId: defaultHostId(), agent, attempted: false };
      journal.save(pending);
    }
    destination.save({ version: 1, apiBase: source.apiBase, roomId, operationKey: key });
    if (!pending.connection) {
      const scopes = [`mcp:room:${roomId}`, 'rooms:read', 'rooms:write', 'heartbeats:report', 'heartbeats:read'];
      pending.attempted = true; journal.save(pending); // Before the non-replayable POST.
      let issued;
      try { issued = await global.request('/api/agent-keys', { body: { scopes, label: pending.label, expiresAt: Date.now() + 30 * 86400000 } }); }
      catch { throw Error(`Key issuance outcome is unknown for label ${pending.label}. Do not issue again or delete this receipt; reconcile that exact label using your identity's API-key list`); }
      registerSecret(issued?.credential); registerSecret(issued?.secret);
      if (issued?.identityId !== account.identityId || typeof issued.credential !== 'string' || !/^rak_[A-Za-z0-9_-]+$/.test(issued.credential)
        || !Array.isArray(issued.scopes) || JSON.stringify([...issued.scopes].sort()) !== JSON.stringify([...scopes].sort())
        || !Number.isSafeInteger(issued.expiresAt) || issued.expiresAt <= Date.now()) throw Error('Issued connection could not be verified; reconcile the import label before another issuance');
      pending.connection = { version: 1, ...binding, displayName: member.displayName ?? source.memberId, permissions: member.permissions ?? [],
        credential: issued.credential, credentialExpiresAt: issued.expiresAt, hostId: pending.hostId, agent: pending.agent,
        permissionApproverId: null, joinedAt: new Date().toISOString() };
      journal.save(pending); // Scoped credential only: survives final-save failure.
    }
    await new RoomClient({ ...pending.connection, fetchImpl }).checkConnection();
    saveConnection(pending.connection, env);
    journal.save({ ...pending, completed: true, connection: null });
    destination.save({ version: 1, apiBase: source.apiBase, roomId, operationKey: null });
    return loadConnection({ roomId }, env);
  } finally { try { destination?.close(); } finally { journal.close(); } }
}

// Reuse a known issued key: only authenticated reads and local atomic save.
export async function importCredential({ credentialFile, roomId, expectedIdentity, origin, agent = null, env = process.env, fetchImpl = fetch }) {
  if (typeof credentialFile !== 'string' || !credentialFile || !id(roomId) || !id(expectedIdentity) || typeof origin !== 'string')
    throw Error('Use import-credential --credential-file <private JSON file> --room <exact room ID> --expected-identity <identity ID> --origin <service origin>');
  const apiBase = normalizeBase(origin);
  let supplied;
  try {
    supplied = readPrivateJson(credentialFile, 8192);
    registerSecret(supplied?.credential);
  } catch { throw Error('Select the existing private scoped-key JSON file; no remote write or key issuance was attempted'); }
  const scopes = [`mcp:room:${roomId}`, 'rooms:read', 'rooms:write', 'heartbeats:report', 'heartbeats:read'];
  if (supplied?.identityId !== expectedIdentity || supplied.roomId !== roomId
    || typeof supplied.credential !== 'string' || !/^rak_[A-Za-z0-9_-]+$/.test(supplied.credential)
    || typeof supplied.keyId !== 'string' || !/^rak_[A-Za-z0-9_-]+$/.test(supplied.keyId)
    || !Number.isSafeInteger(supplied.expiresAt) || supplied.expiresAt <= Date.now()
    || !Array.isArray(supplied.scopes) || JSON.stringify([...supplied.scopes].sort()) !== JSON.stringify([...scopes].sort())
    || supplied.origin !== undefined && supplied.origin !== apiBase)
    throw Error('Scoped-key metadata does not match the selected identity, room, origin, expiry or five listener scopes; nothing was saved');
  const room = new RoomClient({ apiBase, roomId, credential: supplied.credential, fetchImpl });
  const checked = await room.request('/mcp', { body: { jsonrpc: '2.0', id: 'room-acp-import-check', method: 'tools/call',
    params: { name: 'room_check_access', arguments: { roomId } } } });
  const identity = checked?.result?.structuredContent;
  if (checked?.error || checked?.result?.isError || identity?.status !== 'credential_accepted' || identity?.scope !== 'room'
    || identity.identityId !== expectedIdentity || identity.roomId !== roomId || !id(identity.memberId) || identity.kind !== 'agent')
    throw Error('Authenticated scoped credential does not match the selected identity and room; nothing was saved');
  const memberId = identity.memberId;
  const access = await new RoomClient({ apiBase, roomId, memberId, credential: supplied.credential, fetchImpl }).checkConnection();
  const member = access.state.members[memberId];
  const destination = openJoinJournal(configDir(env), 'room-' + digest(roomId.replace(/[^A-Za-z0-9._-]/g, '_')));
  try {
    const owner = destination.read();
    if (owner && (owner.version !== 1 || typeof owner.apiBase !== 'string' || typeof owner.roomId !== 'string'
      || owner.operationKey !== null && typeof owner.operationKey !== 'string')) throw Error('Saved destination ownership is invalid');
    if (owner?.operationKey) throw Error('An earlier setup for this room has an unresolved outcome; reconcile it before importing a known key');
    const existing = listConnections(env).filter(entry => typeof entry.roomId === 'string' && entry.roomId.replace(/[^A-Za-z0-9._-]/g, '_') === roomId.replace(/[^A-Za-z0-9._-]/g, '_'));
    if (existing.length) {
      if (existing.length !== 1 || existing[0].apiBase !== apiBase || existing[0].roomId !== roomId || existing[0].memberId !== memberId
        || existing[0].identityId !== expectedIdentity || existing[0].credential !== supplied.credential)
        throw Error('Another connection is already saved for this room; no connection was replaced');
      return existing[0];
    }
    const connection = { version: 1, apiBase, roomId, memberId, identityId: expectedIdentity, credential: supplied.credential,
      credentialExpiresAt: supplied.expiresAt, keyId: supplied.keyId, scopes: [...supplied.scopes], permissions: [...member.permissions],
      displayName: memberId, hostId: defaultHostId(), agent, permissionApproverId: null, joinedAt: new Date().toISOString() };
    saveConnection(connection, env);
    return connection;
  } finally { destination.close(); }
}
