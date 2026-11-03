// Local prototype only: not wired to HTTP, MCP or the OAuth provider.
import { createHash, randomBytes } from 'node:crypto';
import { mcpInviteOAuthIdentityEpoch } from './mcp-oauth.mjs';
import { ensureExistingSeatOAuthSchema } from './existing-seat-oauth-schema.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw Object.assign(new Error('Existing-seat proof unavailable'), { code: 'existing_seat_proof_unavailable' }); };

export function createExistingSeatProof({ store, inviteOAuth }) {
  const db = store.db;
  ensureExistingSeatOAuthSchema(db);
  // The reference is separate from the browser's CSRF nonce. It can be given
  // to the existing agent without giving it the browser's consent cookie.
  function createHandoff(nonce) {
    return store.transaction(() => {
      const { pending } = inviteOAuth.read(nonce);
      if (pending.grant_id) fail();
      db.prepare('DELETE FROM oauth_existing_seat_handoffs WHERE reference_hash IN (SELECT reference_hash FROM oauth_existing_seat_handoffs WHERE expires_at<=? LIMIT 100)').run(store.now());
      const reference = randomBytes(32).toString('base64url');
      // Starting again must not retain an earlier holder's unconsumed approval.
      db.prepare('DELETE FROM oauth_existing_seat_proofs WHERE nonce_hash=? AND consumed_at IS NULL').run(digest(nonce));
      db.prepare('DELETE FROM oauth_existing_seat_handoffs WHERE nonce_hash=?').run(digest(nonce));
      db.prepare('INSERT INTO oauth_existing_seat_handoffs VALUES(?,?,?)').run(digest(reference), digest(nonce), pending.expires_at);
      return reference;
    });
  }
  function hasHandoff(nonce, reference) {
    if (typeof reference !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(reference)) return false;
    inviteOAuth.read(nonce);
    const row = db.prepare('SELECT nonce_hash,expires_at FROM oauth_existing_seat_handoffs WHERE reference_hash=?').get(digest(reference));
    return Boolean(row && row.nonce_hash === digest(nonce) && row.expires_at > store.now());
  }
  function current(reference, secret, roomId) {
    if (typeof reference !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(reference)) fail();
    const handoff = db.prepare('SELECT * FROM oauth_existing_seat_handoffs WHERE reference_hash=?').get(digest(reference));
    if (!handoff || handoff.expires_at <= store.now()) fail();
    const { pending, request } = inviteOAuth.readByHash(handoff.nonce_hash);
    if (pending.grant_id) fail();
    const identity = store.identities.resolveGlobalIdentitySecret(secret);
    if (!identity || typeof roomId !== 'string') fail();
    let member;
    try { member = store.identities.resolveIdentityLink(identity.identityId, roomId)?.member; } catch { fail(); }
    if (!member || member.kind !== 'agent' || member.active !== true) fail();
    const epoch = mcpInviteOAuthIdentityEpoch(store, identity.identityId, roomId);
    if (!epoch) fail();
    return { pending, request, nonceHash: handoff.nonce_hash, requestHash: digest(pending.request_json), identityId: identity.identityId,
      identityEpoch: epoch, roomId, memberId: member.id };
  }
  function inspect(reference, secret, roomId) {
    const c = current(reference, secret, roomId);
    return { request: c.request, requestHash: c.requestHash, identityId: c.identityId,
      roomId: c.roomId, memberId: c.memberId, expiresAt: c.pending.expires_at };
  }
  function approve(reference, secret, roomId, requestHash) {
    return store.transaction(() => {
      const c = current(reference, secret, roomId);
      if (requestHash !== c.requestHash) fail();
      // A consumed proof is also durable grant provenance; only orphaned
      // short-lived proofs may be swept at the authorization deadline.
      db.prepare('DELETE FROM oauth_existing_seat_proofs WHERE nonce_hash IN (SELECT nonce_hash FROM oauth_existing_seat_proofs WHERE expires_at<=? AND grant_id IS NULL LIMIT 100)').run(store.now());
      const key = c.nonceHash;
      const old = db.prepare('SELECT * FROM oauth_existing_seat_proofs WHERE nonce_hash=?').get(key);
      if (old) {
        if (old.consumed_at !== null || old.request_hash !== c.requestHash || old.identity_id !== c.identityId
          || old.identity_epoch !== c.identityEpoch || old.room_id !== c.roomId || old.member_id !== c.memberId) fail();
        return inspect(reference, secret, roomId);
      }
      db.prepare('INSERT INTO oauth_existing_seat_proofs VALUES(?,?,?,?,?,?,?,NULL,NULL)')
        .run(key, c.requestHash, c.identityId, c.identityEpoch, c.roomId, c.memberId, c.pending.expires_at);
      return inspect(reference, secret, roomId);
    });
  }
  function reviewed(nonce) {
      const { pending, request } = inviteOAuth.read(nonce), key = digest(nonce);
      const proof = db.prepare('SELECT * FROM oauth_existing_seat_proofs WHERE nonce_hash=?').get(key);
      if (!proof || proof.consumed_at !== null || proof.expires_at <= store.now() || pending.grant_id
        || proof.request_hash !== digest(pending.request_json)) fail();
      let member;
      try { member = store.identities.resolveIdentityLink(proof.identity_id, proof.room_id)?.member; } catch { fail(); }
      if (!member || member.id !== proof.member_id || member.kind !== 'agent' || member.active !== true
        || mcpInviteOAuthIdentityEpoch(store, proof.identity_id, proof.room_id) !== proof.identity_epoch) fail();
      return { key, proof, request, member };
  }
  // Only call after verifying the browser's same-origin nonce cookie. The
  // request state and PKCE verifier/challenge are not rendered to the browser.
  function review(nonce) {
    const { proof, request, member } = reviewed(nonce);
    return { clientId: request.clientId, redirectUri: request.redirectUri,
      scopes: request.scopes, roomId: proof.room_id, memberId: proof.member_id,
      displayName: member.displayName, expiresAt: proof.expires_at };
  }
  // The caller must verify the browser nonce cookie and origin before invoking
  // this. Issue the OAuth grant inside callback so failure rolls consumption back.
  function consume(nonce, issue) {
    return store.transaction(() => {
      const { key, proof } = reviewed(nonce);
      if (db.prepare('UPDATE oauth_existing_seat_proofs SET consumed_at=? WHERE nonce_hash=? AND consumed_at IS NULL').run(store.now(), key).changes !== 1) fail();
      return issue({ identityId: proof.identity_id, identityEpoch: proof.identity_epoch, roomId: proof.room_id, memberId: proof.member_id });
    });
  }
  // Prototype transaction boundary: grant creation and proof provenance are
  // atomic. The caller must still enforce browser consent and issue the PKCE code.
  function consumeForGrant(nonce, createGrant, issueCode = result => result) {
    return store.transaction(() => consume(nonce, binding => {
      const result = createGrant(binding);
      if (!result || typeof result.grantId !== 'string' || !result.grantId) fail();
      if (db.prepare('UPDATE oauth_existing_seat_proofs SET grant_id=? WHERE nonce_hash=? AND grant_id IS NULL')
        .run(result.grantId, digest(nonce)).changes !== 1) fail();
      if (db.prepare('UPDATE oauth_invite_pending SET grant_id=?,approval_hash=? WHERE nonce_hash=? AND grant_id IS NULL')
        .run(result.grantId, digest(`existing-seat:${binding.identityId}:${binding.roomId}:${binding.memberId}`), digest(nonce)).changes !== 1) fail();
      return issueCode(result, binding);
    }));
  }
  // A lost consent response may reissue the same unexchanged code, never a
  // new grant. The OAuth provider rejects expired or already exchanged codes.
  function replayGrant(nonce, issueCode) {
    return store.transaction(() => {
      const { pending, request } = inviteOAuth.read(nonce);
      const proof = db.prepare('SELECT * FROM oauth_existing_seat_proofs WHERE nonce_hash=?').get(digest(nonce));
      if (!proof || proof.consumed_at === null || !proof.grant_id || pending.grant_id !== proof.grant_id
        || proof.request_hash !== digest(pending.request_json)) fail();
      let member;
      try { member = store.identities.resolveIdentityLink(proof.identity_id, proof.room_id)?.member; } catch { fail(); }
      if (!member || member.id !== proof.member_id || member.kind !== 'agent' || member.active !== true
        || mcpInviteOAuthIdentityEpoch(store, proof.identity_id, proof.room_id) !== proof.identity_epoch) fail();
      return issueCode({ grantId: proof.grant_id }, { identityId: proof.identity_id,
        identityEpoch: proof.identity_epoch, roomId: proof.room_id, memberId: proof.member_id }, request);
    });
  }
  return { createHandoff, hasHandoff, inspect, approve, review, consume, consumeForGrant, replayGrant };
}
