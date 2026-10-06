import { mcpInvalidRequest } from './mcp-arg-errors.mjs';
// Public contribution tools use the same persisted authority and journals as HTTP.
// No tool admits a room member, provisions credentials or starts a host.
import { PUBLIC_WORK_MCP_TOOLS, ROOM_MCP_PUBLIC_URL } from '../src/room-mcp-join.js';
import { diagnoseArguments, mcpCallError } from './mcp-arg-errors.mjs';
import { ServiceError } from './service-error.mjs';
const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' };
const positive = { type: 'integer', minimum: 1 };
const strings = { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 } };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name, description, inputSchema, readOnly) => ({ name, description, inputSchema,
 _meta: { authorization: ['public_work_recommend', 'public_work_read_task'].includes(name) ? 'none' : 'saved-identity-secret' },
 annotations: { readOnlyHint: readOnly, destructiveHint: name === 'public_work_release', idempotentHint: true, openWorldHint: false } });
const binding = { taskId: id, requestId: id, expectedTermsVersion: positive };
const lease = { type: 'number', exclusiveMinimum: 0, maximum: 24 };
export const publicWorkMcpDefinitions = Object.freeze([
 tool('public_work_recommend', 'Recommend available volunteer tasks. Read only; never claims, joins a room, starts an agent or promises payment. Continue using nextCursor as after when hasMore.', schema({
   skills: { ...strings, description: 'Skills you can apply, as short words such as "typescript" or "docs" (up to 20). Tasks whose title or acceptance criteria contain one rank first; nothing is filtered out.' },
   interests: { ...strings, description: 'Topics you want to work on, such as "accessibility" or "openapi" (up to 20). Ranked the same way as skills; nothing is filtered out.' },
   limit: { type: 'integer', minimum: 1, maximum: 5, description: 'How many recommendations to return, 1-5. Default 3.' },
   after: { ...id, description: 'Paging cursor: pass the previous response nextCursor when hasMore is true.' }
 }), true),
 tool('public_work_read_task', 'Read current public terms, repository paths and lease. No private room data or admission. Inspect before claiming.', schema({ taskId: { ...id, description: 'The task id from public_work_recommend (task.taskId), for example "t_abc".' } }, ['taskId']), true),
 tool('public_work_claim', 'Explicitly claim one public volunteer task with your saved identity. No room admission. Preserve requestId and exact arguments after an unknown response; expectedTermsVersion comes from a fresh task read.', schema({ ...binding, leaseHours: lease }, Object.keys(binding)), false),
 tool('public_work_renew', 'Renew your own public claim generation. No host execution. Retry unchanged with the same requestId.', schema({ ...binding, generation: positive, leaseHours: lease }, [...Object.keys(binding), 'generation']), false),
 tool('public_work_release', 'Release your own public claim generation. Frees its repository paths; does not delete a submitted receipt. Retry unchanged with the same requestId.', schema({ ...binding, generation: positive }, [...Object.keys(binding), 'generation']), false),
 tool('public_work_finish', 'Submit exact UTF-8 artifact text (at most 64 KiB) for your current claim generation and free its paths. Checks are producer-reported. The immutable receipt proves stored bytes only, not acceptance or payment. The result includes publicReceipt.url and artifactUrl for independent byte verification. Retry unchanged with the same requestId.', schema({ ...binding, generation: positive, artifactText: { type: 'string', maxLength: 65536 }, checksReported: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } } }, [...Object.keys(binding), 'generation', 'artifactText', 'checksReported']), false),
 tool('public_work_my_review', 'Read only your own contribution feedback using your saved identity. Includes shared decision feedback when recorded; excludes private Room and reviewer identities and does not imply credits or payment.', schema({ receiptId: id }, ['receiptId']), true)
]);
if (publicWorkMcpDefinitions.map(tool => tool.name).join() !== PUBLIC_WORK_MCP_TOOLS.join()) throw new Error('Public work MCP catalog drift');
export const anonymousPublicWorkMcpTools = publicWorkMcpDefinitions.slice(0, 2);
export const isPublicWorkMcpTool = name => PUBLIC_WORK_MCP_TOOLS.includes(name);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const result = (id, value, isError = false) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) } });
export function handlePublicWorkMcp(store, message, secret, mcpUrl = ROOM_MCP_PUBLIC_URL) {
 const hasId = object(message) && Object.hasOwn(message, 'id');
 const requestId = message?.id;
 if (!object(message) || message.jsonrpc !== '2.0' || message.method !== 'tools/call'
   || (hasId && !(typeof requestId === 'string' && requestId.length <= 128 || Number.isSafeInteger(requestId)))) return mcpInvalidRequest();
 if (!hasId) return null; // Notifications never initiate a claim mutation.
 const name = message.params?.name, args = message.params?.arguments === undefined ? {} : message.params.arguments;
 const selected = publicWorkMcpDefinitions.find(tool => tool.name === name);
 const problems = diagnoseArguments(selected.inputSchema, args);
 if (problems) return mcpCallError(requestId, { reason: 'invalid_arguments', tool: name, ...problems });
 if (!secret && !anonymousPublicWorkMcpTools.includes(selected)) return mcpCallError(requestId, { reason: 'auth_required', tool: name });
 try {
  let value;
  if (name === 'public_work_recommend') value = store.publicWorkClaims.match(secret, { ...args, autoClaim: false });
  else if (name === 'public_work_read_task') value = store.readTransaction(() => {
   if (secret && !store.identities.resolveGlobalIdentitySecret(secret)) throw new ServiceError(401, 'unauthenticated', 'Unknown or revoked identity');
   return store.publicWorkClaims.read(args.taskId);
  });
  else if (name === 'public_work_my_review') value = store.publicWorkReviews.contributorReview(secret, args.receiptId);
  else { const { taskId, ...input } = args; value = store.publicWorkClaims.act(taskId, secret, name.slice('public_work_'.length), input); }
  if (value.receipt) {
   const base = new URL(mcpUrl);
   const prefix = base.pathname.startsWith('/room/mcp') ? '/room' : '';
   const receiptUrl = new URL(prefix + '/api/public-work/receipts/' + value.receipt.receiptId, base).href;
   value = { ...value, publicReceipt: { url: receiptUrl, artifactUrl: receiptUrl + '/artifact', verification: 'sha256_bytes_only' } };
  }
  return result(requestId, value);
 } catch (error) {
  if (error instanceof ServiceError && error.status === 401) return mcpCallError(requestId, { reason: 'auth_required', tool: name, hint: 'Use your current saved identity secret in the Authorization bearer header; public contributions require no Room admission.' });
  return result(requestId, error instanceof ServiceError ? { status: error.status, code: error.code, message: error.message }
   : { status: 500, code: 'internal', message: 'Request could not be completed' }, true);
 }
}
