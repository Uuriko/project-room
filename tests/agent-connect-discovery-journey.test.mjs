import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {agentPages} from '../scripts/build-agent-docs.mjs';
import {agentCard, llmsTxt, llmsFullTxt, skillMd} from '../server/agent-discovery.mjs';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';

test('a cold agent finds the official connection before unrelated work or legacy room names', () => {
  const first = llmsTxt().slice(0, 1800);
  assert.match(first, /Project Room connects/);
  assert.match(first, /https:\/\/room\.trydemigod\.com\/mcp/);
  assert.match(first, /https:\/\/github\.com\/Uuriko\/project-room/);
  assert.match(first, /ChatGPT Dot/);
  assert.match(first, /\/docs\/agents/);
  assert.doesNotMatch(first, /muse-room|room-fafdae79cf8c/);
  for (const document of [JSON.stringify(agentCard()), llmsTxt(), llmsFullTxt(), skillMd()]) {
    assert.doesNotMatch(document, /room-fafdae79cf8c/, 'public discovery must not present the private maintainer room as an open default');
  }
});

test('the indexable guide names the product, canonical endpoint and existing Dot path without a runtime', () => {
  const html = agentPages().get('docs/agents/index.html');
  assert.match(html, /<title>[^<]*Project Room[^<]*Dot/);
  assert.match(html, /<h1>Connect to Project Room<\/h1>/);
  assert.match(html, /https:\/\/room\.trydemigod\.com\/mcp/);
  assert.match(html, /href="\/docs\/agents\/paste"/);
  assert.match(html, /plugin/);
  assert.match(html, /approval/i);
  assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")/);
});

test('anonymous discovery is readable while a Room access check still requires authentication', async t => {
  const store = new RoomStore(':memory:');
  const server = createRoomServer({store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = await fetch(origin + '/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-robots-tag'), 'all');
  const html = await home.text();
  assert.match(html, /<title>Project Room[^<]*AI agents/);
  assert.match(html, /href="\/docs\/agents"/);
  const packet = await fetch(origin + '/llms.txt');
  assert.equal(packet.status, 200);
  assert.equal(packet.headers.get('x-robots-tag'), 'all');
  assert.match((await packet.text()).slice(0, 1800), /ChatGPT Dot/);
  const check = await fetch(origin + '/mcp', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 'anonymous-check', method: 'tools/call', params: {name: 'room_check_access', arguments: {roomId: 'unapproved-room'}}})
  });
  assert.equal(check.status, 401);
});

// Repository visitors must be routed to connection before maintainer work.
test('repository entry points explain connecting without a checkout or contribution', () => {
  for (const file of ['README.md', 'AGENTS.md', 'docs/AGENT-START-HERE.md']) {
    const first = readFileSync(new URL('../' + file, import.meta.url), 'utf8').slice(0, 2200);
    assert.match(first, /https:\/\/room\.trydemigod\.com\/docs\/agents/, file);
    assert.match(first, /https:\/\/room\.trydemigod\.com\/mcp/, file);
    assert.match(first, /existing agent|existing identity|saved identity|existing host/, file);
  }
  const paste = agentPages().get('docs/agents/paste.html');
  assert.match(paste, /Start with this prompt/);
  assert.match(paste, /Open rooms allow ordinary read\/chat admission without waiting/);
});

test('public connection entry points distinguish host consent, verified membership and Room roles', async () => {
  const {PUBLIC_LOBBY_CONNECT_PROMPT}=await import('../server/agent-paste-copy.mjs');
  for(const text of [PUBLIC_LOBBY_CONNECT_PROMPT,llmsFullTxt(),skillMd()]) {
    assert.match(text,/installed Project Room plugin or MCP connection/);
    assert.match(text,/Connect or Allow approval/);
    assert.match(text,/actual Project Room tools/);
    assert.match(text,/same member/);
    assert.match(text,/keep setup pending|setup complete while.*pending/);
    assert.match(text,/host consent does not grant/);
    assert.doesNotMatch(text,/A successful authenticated read confirms you are connected/);
  }
  const guide=agentPages().get('docs/agents/paste.html');
  assert.match(guide,/Finish the host connection/);
  assert.match(guide,/do not ask for another approval just to repeat a successful check/);
  assert.match(guide,/do not use new-agent consent to replace it/);
});
