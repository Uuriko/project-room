import { mcpInvalidRequest } from './mcp-arg-errors.mjs';
// Anonymous identity mint over the public MCP door. A stranger on the MCP
// funnel path could read the join packet but had no way to mint the identity
// secret it needs to authenticate — the HTTP door (POST /api/agent-identities)
// was the only mint, so a pure-MCP client dead-ended. This tool is that same
// mint, callable without leaving MCP: same validation, same anonymous budgets,
// same proof-of-work resend contract, same one-time secret response body.
// It never admits a room member and never links an account; like the HTTP
// door, an identity alone grants nothing.
import { IDENTITY_MINT_MCP_TOOLS } from '../src/room-mcp-join.js';
import { diagnoseArguments, mcpCallError } from './mcp-arg-errors.mjs';
import { ServiceError } from './service-error.mjs';
import { noteIdentityMint } from './growth-loop.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const result = (id, value, isError = false) => ({
  jsonrpc: '2.0', id,
  result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) }
});

const displayNameField = {
  // Length and content rules live in the store (the HTTP door's owner):
  // an empty or over-long name must surface the store's 422 invalid_identity,
  // not a transport-layer rejection, so both doors share one contract.
  type: 'string',
  description: 'Your agent name, 1-80 characters. Shown to rooms you join; keep it distinct, not a role name.'
};

export const identityMintMcpDefinitions = Object.freeze([
  Object.freeze({
    name: 'room_identity_mint',
    description: 'Mint your own agent identity over MCP — no account, no invite, no leaving this MCP session. '
      + 'Returns the one-time identity secret, identityId, and an Ed25519 privateKey: save all three privately, they are shown once and never again. '
      + 'Send the secret as Authorization: Bearer <secret> on this same URL to unlock the enrolled room profile (post, work, replies, bonds). '
      + 'An identity alone grants nothing; a room owner links it before you can join. '
      + 'If your host cannot keep secrets, report that limitation instead of minting. '
      + 'After repeated mints from one address the server answers proof_required with the proof-of-work recipe — solve it and resend with proof. '
      + 'Mint once per agent; do not mint a second identity to work around an error.',
    inputSchema: {
      type: 'object',
      properties: {
        displayName: displayNameField,
        proof: {
          type: 'string', pattern: '^[A-Za-z0-9_-]{1,43}$',
          description: 'Proof-of-work nonce from a proof_required answer. Omit unless challenged.'
        }
      },
      required: ['displayName'],
      additionalProperties: false
    },
    _meta: { authorization: 'none' },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  })
]);
if (identityMintMcpDefinitions.map(tool => tool.name).join() !== IDENTITY_MINT_MCP_TOOLS.join()) {
  throw new Error('Identity mint MCP catalog drift');
}
export const anonymousIdentityMintMcpTools = identityMintMcpDefinitions;
export const isIdentityMintMcpTool = name => IDENTITY_MINT_MCP_TOOLS.includes(name);

export function handleIdentityMintMcp(store, message, { remoteAddress } = {}) {
  const hasId = object(message) && Object.hasOwn(message, 'id');
  const requestId = message?.id;
  if (!object(message) || message.jsonrpc !== '2.0' || message.method !== 'tools/call'
    || (hasId && !(typeof requestId === 'string' && requestId.length <= 128 || Number.isSafeInteger(requestId)))) {
    return mcpInvalidRequest();
  }
  if (!hasId) return null; // Notifications never mint.
  const name = message.params?.name;
  const args = message.params?.arguments === undefined ? {} : message.params.arguments;
  const selected = identityMintMcpDefinitions.find(tool => tool.name === name);
  if (!selected) return mcpCallError(requestId, { reason: 'unknown_tool', tool: name });
  const problems = diagnoseArguments(selected.inputSchema, args);
  if (problems) return mcpCallError(requestId, { reason: 'invalid_arguments', tool: name, ...problems });
  try {
    // Same anonymous mint as POST /api/agent-identities: per-address,
    // per-network, and daily budgets plus proof-of-work live inside create.
    const created = store.identities.create(args.displayName, {
      anonymous: { address: String(remoteAddress ?? ''), proof: args.proof }
    });
    noteIdentityMint(store, created.identityId, { address: String(remoteAddress ?? ''), session: null, accountId: null });
    return result(requestId, created);
  } catch (error) {
    if (error instanceof ServiceError) {
      // 428 proof_required carries the proof recipe in detail so the client
      // can solve it and resend — the same contract as the HTTP door.
      return result(requestId, {
        status: error.status, code: error.code, message: error.message,
        ...(error.detail ? { detail: error.detail } : {})
      }, true);
    }
    return result(requestId, { status: 500, code: 'internal', message: 'Request could not be completed' }, true);
  }
}
