// Offline-only candidate: no file/network I/O and no runtime boot-gate bypass.
// Trust comes from caller-pinned origin/key/identity, never the artifact's JWKS.
import {isDeepStrictEqual} from 'node:util';
import {discoveryDoc, ROOM_ORIGIN, deployedInfo} from './agent-discovery.mjs';
import {instanceDiscoveryBody} from './node-discovery-origin.mjs';
import {signCard, verifyCardSignature, signCardJws, verifyCardJws, publicKeyToJwk} from './agent-card-signing.mjs';
const SCHEMA = 'project-room-instance-card/1';
const JWKS_PATH = '/.well-known/jwks.json';
const jsonClone = value => JSON.parse(JSON.stringify(value));
const exactKeys = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
// Reject prototype-sensitive names before using legacy signing canonicalization.
// JSON.parse preserves own __proto__ keys, whereas assignment into {} can lose them.
function safeJsonTree(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.keys(value).every(key => !['__proto__', 'constructor', 'prototype'].includes(key)
    && safeJsonTree(value[key]));
}
const canonicalBase64url = value => typeof value === 'string' && value.length > 0
  && Buffer.from(value, 'base64url').toString('base64url') === value;

function validatePin({origin, keyId, agentId, publicKey}) {
  const url = new URL(origin);
  if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol)) throw new TypeError('Expected an exact HTTP(S) instance origin');
  if (origin === ROOM_ORIGIN) throw new TypeError('Hosted card bytes and signing remain owned by the hosted build');
  if (typeof agentId !== 'string' || !agentId.trim()) throw new TypeError('Expected a pinned instance agent identity');
  publicKeyToJwk({publicKey, keyId});
}

export function signInstanceCardArtifact({origin, keyId, agentId, publicKey, privateKey}) {
  const pin = {origin, keyId, agentId, publicKey};
  validatePin(pin);
  const card = JSON.parse(instanceDiscoveryBody(discoveryDoc('/.well-known/agent.json'), origin));
  delete card.signed; delete card.unsignedReason;
  Object.assign(card, {keyId, signatureAgentId: agentId, publicKey, signedRevision: deployedInfo().revision});
  card.cardSignature = signCard({agentId, card, privateKey});
  card.signatures = [signCardJws({card, privateKey, keyId, jku: origin + JWKS_PATH})];
  const artifact = {schema: SCHEMA, card, jwks: {keys: [publicKeyToJwk({publicKey, keyId})]}};
  // Detect a mismatched supplied public/private key before returning any artifact.
  if (!verifyInstanceCardArtifact(artifact, pin)) throw new Error('Instance signing key does not match the pinned public identity');
  return artifact;
}

export function verifyInstanceCardArtifact(input, pin) {
  try {
    validatePin(pin);
    // Copy before validating; callers cannot mutate fields midway through checks.
    const artifact = jsonClone(input);
    if (!safeJsonTree(artifact) || !exactKeys(artifact, ['card','jwks','schema']) || artifact.schema !== SCHEMA) return false;
    const {card, jwks} = artifact;
    if (card.base_url !== pin.origin || card.url !== pin.origin || card.public_doors?.origin !== pin.origin) return false;
    if (card.signatureAgentId !== pin.agentId || card.keyId !== pin.keyId || card.publicKey !== pin.publicKey) return false;
    if ('signed' in card || 'unsignedReason' in card || card.signedRevision !== deployedInfo().revision) return false;
    for (const value of Object.values(card.endpoints ?? {})) if (!value.startsWith(pin.origin + '/')) return false;
    for (const entry of card.supportedInterfaces ?? []) if (new URL(entry.url).origin !== pin.origin) return false;
    if (!isDeepStrictEqual(jwks, {keys: [publicKeyToJwk(pin)]})) return false;
    if (!Array.isArray(card.signatures) || card.signatures.length !== 1) return false;
    const jws = card.signatures[0];
    if (!exactKeys(jws, ['protected','signature']) || !canonicalBase64url(jws.protected) || !canonicalBase64url(jws.signature)) return false;
    const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString('utf8'));
    if (!exactKeys(header, ['alg','jku','kid','typ'])) return false;
    if (header.alg !== 'EdDSA' || header.typ !== 'JOSE' || header.kid !== pin.keyId || header.jku !== pin.origin + JWKS_PATH) return false;
    // Bind the public artifact to this exact rendered build, not just an arbitrary
    // payload signed by a key holder. In particular, forbid extra/private fields.
    const expected = JSON.parse(instanceDiscoveryBody(discoveryDoc('/.well-known/agent.json'), pin.origin));
    delete expected.signed; delete expected.unsignedReason;
    for (const field of ['keyId','signatureAgentId','publicKey','signedRevision','cardSignature']) expected[field] = card[field];
    // Structural comparison must precede legacy canonicalization: do not let an
    // unexpected JSON key disappear from both the signature and schema checks.
    const {signatures: ignored, ...actual} = card;
    if (!isDeepStrictEqual(expected, actual)) return false;
    if (!verifyCardSignature({agentId: pin.agentId, card, publicKey: pin.publicKey, signature: card.cardSignature})) return false;
    return verifyCardJws({card, publicKey: pin.publicKey, jws});
  } catch { return false; }
}
