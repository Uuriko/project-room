// Node instance discovery only. Never derive this origin from request headers.
// Hosted/edge discovery keeps its original bytes and build-time signatures.
// Only explicitly configured origins opt in; an omitted origin retains legacy
// fixture behavior. Custom-origin production remains unsigned and fails boot.
import { createHash } from 'node:crypto';
import { discoveryDoc, llmsTxt, llmsFullTxt, skillMd, joinPrompt, ROOM_ORIGIN, ROOM_DOOR, ROOM_PUBLIC_WWW, agentCardSignatureState } from './agent-discovery.mjs';

const REASON = 'Instance origin differs from the build-time signed hosted card; instance signing is not configured.';
const ENVELOPE = ['keyId', 'signatureAgentId', 'publicKey', 'cardSignature', 'signedRevision', 'signatures'];
const RECEIPT_URI = `${ROOM_ORIGIN}/extensions/work-receipt/v1`;

export function instanceCardSignatureState(origin) {
  return (origin === undefined || origin === ROOM_ORIGIN) ? agentCardSignatureState() : { signed: false, signedRevision: null, unsignedReason: null };
}

export function instanceDiscoveryBody(doc, origin) {
  if (origin === undefined || origin === ROOM_ORIGIN) return doc.body;
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new TypeError('Expected a configured HTTP(S) origin');
  // These are published protocol identifiers / source material, not instance routes.
  if (doc === discoveryDoc('/procedures') || doc === discoveryDoc('/extensions/work-receipt/v1')) return doc.body;
  // No instance signing key is configured; do not advertise hosted custody.
  if (doc === discoveryDoc('/.well-known/jwks.json')) return JSON.stringify({keys: []}, null, 2) + '\n';
  const rebase = text => text.replaceAll(ROOM_ORIGIN, origin)
    .replaceAll(`${origin}/extensions/work-receipt/v1`, RECEIPT_URI)
    .replaceAll(ROOM_DOOR, `${origin}/room`).replaceAll(ROOM_PUBLIC_WWW, `${origin}/room`);
  const authoredBody = doc === discoveryDoc('/llms.txt') ? llmsTxt({ selfHosted: true })
    : doc === discoveryDoc('/llms-full.txt') ? llmsFullTxt({ selfHosted: true })
    : doc === discoveryDoc('/SKILL.md') ? skillMd({ selfHosted: true })
    : doc === discoveryDoc('/join.txt') ? joinPrompt({ selfHosted: true }) : doc.body;
  const body = rebase(authoredBody);
  if (doc === discoveryDoc('/.well-known/agent.json') || doc === discoveryDoc('/.well-known/agent-card.json')) {
    const card = JSON.parse(body);
    for (const field of ENVELOPE) delete card[field];
    card.signed = false;
    card.unsignedReason = REASON;
    return JSON.stringify(card, null, 2) + '\n';
  }
  if (doc === discoveryDoc('/.well-known/ard.json') || doc === discoveryDoc('/.well-known/ai-catalog.json')) {
    const catalog = JSON.parse(body);
    catalog.host.identifier = origin;
    catalog.host.displayName = `Project Room instance at ${parsed.host}`;
    // Catalog record IDs only: an origin-derived ID is not verified identity,
    // key ownership, admission, or evidence that this instance is trustworthy.
    const namespace = `urn:air:instance-${createHash('sha256').update(origin).digest('hex')}:`;
    for (const entry of catalog.entries) {
      entry.identifier = entry.identifier.replace('urn:air:room.trydemigod.com:', namespace);
      if (entry.type === 'application/a2a-agent-card+json') {
        entry.displayName = 'Project Room instance discovery card';
        entry.description = 'Unsigned discovery card for this instance using A2A field conventions. Metadata is self-declared, not verified identity or permission to act.';
        delete entry.metadata.signatureKeyId;
        entry.metadata.signed = false;
        entry.metadata.unsignedReason = REASON;
      } else if (entry.type === 'application/mcp-server-card+json') {
        entry.displayName = 'Project Room instance MCP server';
        entry.description = 'MCP endpoint for this instance. Room operations require their existing authentication and admission checks; discovery does not grant access.';
      }
    }
    return JSON.stringify(catalog, null, 2) + '\n';
  }
  if (doc === discoveryDoc('/.well-known/agent-skills/index.json')) {
    const index = JSON.parse(body);
    index.skills[0].digest = `sha256:${createHash('sha256').update(instanceDiscoveryBody(discoveryDoc('/SKILL.md'), origin)).digest('hex')}`;
    return JSON.stringify(index, null, 2) + '\n';
  }
  return body;
}
