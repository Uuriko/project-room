// One Node signing interface for explicit public configuration and verification.
export { readInstanceCardFiles } from './instance-card-files.mjs';
// Verify bounded public build output at startup. No private keys, key lookup,
// network requests, or trust-on-first-use. Caller owns trusted configuration.
import {discoveryDoc, ROOM_ORIGIN, deployedInfo} from './agent-discovery.mjs';
import {instanceDiscoveryBody} from './node-discovery-origin.mjs';
import {verifyInstanceCardArtifact} from './instance-card-artifact.mjs';
const MAX_ARTIFACT_BYTES = 256 * 1024;
const fail = () => { throw new Error('Refusing instance card: bounded public artifact, trusted pin, exact HTTPS origin and stamped matching build are required'); };

export function loadInstanceCardRuntime({origin, instanceCard} = {}) {
  if (instanceCard === undefined) return null;
  if (origin === ROOM_ORIGIN || !instanceCard || typeof instanceCard !== 'object') fail();
  if (Object.keys(instanceCard).sort().join() !== 'artifactJson,trustedPin') fail();
  const {artifactJson, trustedPin} = instanceCard;
  if (typeof artifactJson !== 'string' || artifactJson.length > MAX_ARTIFACT_BYTES || Buffer.byteLength(artifactJson) > MAX_ARTIFACT_BYTES) fail();
  if (!trustedPin || Object.keys(trustedPin).sort().join() !== 'agentId,keyId,origin,publicKey') fail();
  if (Object.values(trustedPin).some(value => typeof value !== 'string' || !value.length || value.length > 2048)) fail();
  let parsed;
  try { parsed = new URL(origin); } catch { fail(); }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || trustedPin.origin !== origin) fail();
  const deployed = deployedInfo();
  if (deployed.stale || !/^[a-f0-9]{40}$/.test(deployed.revision) || !deployed.buildId || ['dev','unstamped'].includes(deployed.buildId)) fail();
  let artifact;
  try { artifact = JSON.parse(artifactJson); } catch { fail(); }
  if (!verifyInstanceCardArtifact(artifact, trustedPin)) fail();
  // Retain only immutable serialized PUBLIC output, not caller-owned objects.
  const keyId = trustedPin.keyId;
  const cardBody = JSON.stringify(artifact.card, null, 2) + '\n';
  const jwksBody = JSON.stringify(artifact.jwks, null, 2) + '\n';
  return Object.freeze({
    signatureState: Object.freeze({signed: true, signedRevision: deployed.revision, unsignedReason: null}),
    body(doc) {
      if (doc === discoveryDoc('/.well-known/agent.json') || doc === discoveryDoc('/.well-known/agent-card.json')) return cardBody;
      if (doc === discoveryDoc('/.well-known/jwks.json')) return jwksBody;
      const body = instanceDiscoveryBody(doc, origin);
      if (doc === discoveryDoc('/.well-known/ard.json') || doc === discoveryDoc('/.well-known/ai-catalog.json')) {
        const catalog = JSON.parse(body);
        const entry = catalog.entries.find(value => value.type === 'application/a2a-agent-card+json');
        entry.description = 'Signed discovery card for this instance. Verify the signature against an independently trusted key; key possession is not a global identity or permission to act.';
        entry.metadata.signed = true;
        entry.metadata.signatureKeyId = keyId;
        delete entry.metadata.unsignedReason;
        return JSON.stringify(catalog, null, 2) + '\n';
      }
      return body;
    }
  });
}
