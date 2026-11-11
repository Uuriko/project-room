// Stateless MCP 2026-07-28 subset. Wire contract checked against the official
// @modelcontextprotocol/client 2.4.0 reference client; legacy stays separate.
import { ROOM_MCP_SERVER_NAME, ROOM_MCP_SERVER_VERSION } from '../src/room-mcp-join.js';
export const MODERN_MCP_VERSION = '2026-07-28';
const prefix = 'io.modelcontextprotocol/';
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const header = (headers, name) => headers?.get ? headers.get(name) : headers?.[name.toLowerCase()];
const methods = new Set(['server/discover', 'tools/list', 'tools/call', 'events/list', 'events/subscribe', 'events/unsubscribe']);
function decode(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('=?base64?')) return value;
  const match = /^=\?base64\?([A-Za-z0-9+/]+={0,2})\?=$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64');
  return bytes.toString('base64') === match[1] ? bytes.toString('utf8') : null;
}
export function modernMcpRequest(message, headers) {
  const meta = message?.params?._meta;
  const claim = object(meta) && ['protocolVersion', 'clientInfo', 'clientCapabilities', 'logLevel'].some(key => Object.hasOwn(meta, prefix + key));
  const version = header(headers, 'mcp-protocol-version');
  if (!claim && version !== MODERN_MCP_VERSION) return null;
  const id = typeof message?.id === 'string' || Number.isSafeInteger(message?.id) ? message.id : null;
  const error = (code, text, data) => ({ version: MODERN_MCP_VERSION, reply: { jsonrpc: '2.0', id, error: { code, message: text, ...(data ? { data } : {}) } } });
  if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (Object.hasOwn(message, 'id') && id === null)
      || Object.keys(message).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key)) || !object(message.params)) return error(-32600, 'Invalid JSON-RPC request');
  const requested = meta?.[prefix + 'protocolVersion'];
  if (version && version !== requested || header(headers, 'mcp-method') && decode(header(headers, 'mcp-method')) !== message.method) return error(-32020, 'MCP header/body mismatch');
  if (!object(meta) || typeof requested !== 'string' || !object(meta[prefix + 'clientCapabilities'])) return error(-32602, 'Required per-request MCP metadata is missing or invalid');
  if (Object.entries(meta[prefix + 'clientCapabilities']).some(([key, value]) => ['experimental', 'sampling', 'elicitation', 'roots', 'extensions'].includes(key) && !object(value))) return error(-32602, 'Invalid client capabilities');
  const info = meta[prefix + 'clientInfo'];
  if (info !== undefined && (!object(info) || typeof info.name !== 'string' || typeof info.version !== 'string')) return error(-32602, 'Invalid clientInfo');
  if (requested !== MODERN_MCP_VERSION) return error(-32022, 'Unsupported protocol version', { requested, supported: [MODERN_MCP_VERSION] });
  if (Object.hasOwn(message, 'id')) {
    if (!version || !header(headers, 'mcp-method')) return error(-32020, 'Required MCP headers are missing');
    if (message.method === 'tools/call' && decode(header(headers, 'mcp-name')) !== message.params.name) return error(-32020, 'Mcp-Name must match the tool name');
  } else return { version: MODERN_MCP_VERSION, reply: null };
  if (!methods.has(message.method)) return error(-32601, 'Method not found');
  if (message.method === 'tools/call' && (typeof message.params.name !== 'string' || message.params.arguments !== undefined && !object(message.params.arguments))) return error(-32602, 'Invalid tool call');
  if (message.params.requestState !== undefined || message.params.inputResponses !== undefined) return error(-32602, 'This server does not issue input requests');
  return { version: MODERN_MCP_VERSION };
}
export async function dispatchModernMcp(message, options, dispatch) {
  const request = message.method === 'server/discover' ? { jsonrpc: '2.0', id: message.id, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'per-request', version: '1' },
  } } : message;
  let reply = await dispatch(request, options);
  if (!reply?.result) return reply;
  let result = reply.result;
  if (message.method === 'server/discover') result = {
    supportedVersions: [MODERN_MCP_VERSION], capabilities: { tools: {},
      ...(options.roomMcp?.nativeEvents && /^bearer (?:oat|iat)_/i.test(options.authorization ?? '') ? { events: {} } : {}) },
    instructions: result.instructions,
  };
  if (message.method === 'tools/list') result = { ...result, ttlMs: 0, cacheScope: 'private', tools: result.tools.map(({ execution, ...tool }) => tool) };
  return { ...reply, result: { ...result, resultType: 'complete', _meta: { ...result._meta,
    [prefix + 'serverInfo']: { name: ROOM_MCP_SERVER_NAME, version: ROOM_MCP_SERVER_VERSION } } } };
}
