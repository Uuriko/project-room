// Exercises server/mcp-modern.mjs through the shared HTTP boundary, including official SDK requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dispatchRoomMcp, writeRoomMcpNode } from '../server/mcp-http.mjs';
const version = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} };
const message = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } });
const headers = (method, name) => ({ 'mcp-protocol-version': version, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) });
test('modern requests require envelope/header consistency, complete results and scoped caching', async () => {
  const discovery = await dispatchRoomMcp(message('server/discover'), { headers: headers('server/discover') });
  assert.deepEqual(discovery.result.supportedVersions, [version]); assert.equal(discovery.result.resultType, 'complete');
  assert.ok(discovery.result._meta['io.modelcontextprotocol/serverInfo']); assert.equal(discovery.result.capabilities.events, undefined);
  const list = await dispatchRoomMcp(message('tools/list'), { headers: headers('tools/list') });
  assert.equal(list.result.ttlMs, 0); assert.equal(list.result.cacheScope, 'private');
  for (const [rpc, h, code] of [
    [message('tools/list'), headers('tools/call'), -32020],
    [message('tools/list'), {}, -32020],
    [message('tools/list', { _meta: {} }), { 'mcp-protocol-version': version }, -32020],
    [{ ...message('tools/list'), params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } }, { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' }, -32022],
    [message('initialize'), headers('initialize'), -32601],
    [message('tools/call', { name: 'room_join_prompt' }), headers('tools/call', 'other'), -32020],
  ]) assert.equal((await dispatchRoomMcp(rpc, { headers: h })).error.code, code);
});
// Optional pinned reference package lives outside the app/runtime dependency tree.
// npm install --prefix /tmp/room-mcp2-reference --ignore-scripts @modelcontextprotocol/client@2.4.0
const reference = process.env.ROOM_MCP_REFERENCE_CLIENT;
test('official SDK 2.4.0 pinned modern client discovers, lists and calls real HTTP', { skip: !reference }, async t => {
  const { Client, StreamableHTTPClientTransport } = await import(reference);
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ body: JSON.parse(body), headers: req.headers });
    await writeRoomMcpNode(req, res, new URL(req.url, 'http://localhost'), { bodyText: body });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'Room interoperability test', version: '1' }, { versionNegotiation: { mode: { pin: version } } });
  t.after(async () => { await client.close(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  assert.ok((await client.listTools()).tools.length);
  assert.ok((await client.callTool({ name: 'room_join_prompt', arguments: {} })).content.length);
  assert.deepEqual(seen.map(x => x.body.method), ['server/discover', 'tools/list', 'tools/call']);
  assert.ok(seen.every(x => x.headers['mcp-protocol-version'] === version));
});
