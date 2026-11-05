// Connect path (walkthrough 2026-11-04): /download leads to connecting an
// agent, the paste prompt is short, and the home no-JS hero leads with connect.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {downloadPageHtml,downloadPageCsp,DOWNLOAD_CONNECT_HOSTS,DOWNLOAD_COPY_SCRIPT_HASH} from '../server/download-page.mjs';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';

test('/download leads with the MCP URL, copy buttons, host snippets and the paste prompt',()=>{
  const html=downloadPageHtml();
  const connect=html.indexOf('id="connect"');assert.ok(connect>0&&connect<html.indexOf('No public Mac app'),'connect comes before platform status');
  assert.match(html,/<textarea id="connect-mcp-url" readonly[^>]*>https:\/\/room\.trydemigod\.com\/mcp<\/textarea>/);
  assert.match(html,/data-copy="connect-mcp-url"/);
  assert.match(html,/href="\/docs\/agents\/paste"/);
  for(const id of DOWNLOAD_CONNECT_HOSTS){assert.match(html,new RegExp(`id="connect-${id}"`));assert.match(html,new RegExp(`data-copy="connect-${id}"`));}
  assert.match(html,/PROJECT_ROOM_SECRET/);assert.doesNotMatch(html,/ais_|rak_|Bearer [A-Za-z0-9]{20}/,'no secrets');
  const script=/<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.equal(createHash('sha256').update(script).digest('base64'),DOWNLOAD_COPY_SCRIPT_HASH,'CSP hash matches the only inline script');
  assert.match(downloadPageCsp('https://room.trydemigod.com'),new RegExp(`script-src [^;]*'sha256-${DOWNLOAD_COPY_SCRIPT_HASH.replace(/[+/]/g,'\\$&')}'`));
});

test('served /download carries the hashed-script CSP',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'connect-path-'));const store=new RoomStore(join(dir,'db'));const server=createRoomServer({store});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const res=await fetch(`http://127.0.0.1:${server.address().port}/download`);assert.equal(res.status,200);
  assert.match(res.headers.get('content-security-policy'),new RegExp(`'sha256-${DOWNLOAD_COPY_SCRIPT_HASH.replace(/[+/]/g,'\\$&')}'`));
  assert.match(await res.text(),/id="connect-mcp-url"/);
});

test('paste prompt is short and keeps the essentials',()=>{
  const md=readFileSync(new URL('../docs/agents/paste.md',import.meta.url),'utf8');
  const prompt=/## Start with this prompt[\s\S]*?```text\n([\s\S]*?)\n```/.exec(md)[1];
  const sentences=prompt.split('\n').slice(1).join(' ').split(/(?<=[.!?])\s+/).filter(Boolean);
  assert.ok(sentences.length<=4,`at most 4 sentences, got ${sentences.length}`);
  for(const must of ['https://room.trydemigod.com/mcp','approval','project-room-lobby','room_check_access','replacement agent','secrets','save the result'])assert.ok(prompt.includes(must),must);
});

test('home no-JS hero leads with a distinct connect block',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const hero=html.match(/<section id="static-hero"[\s\S]*?<\/section>/)[0];
  const block=hero.match(/<div class="static-hero-connect"[\s\S]*?<\/div>/)?.[0];assert.ok(block);
  assert.ok(hero.indexOf(block)<hero.indexOf('connects the AI agents you already use'),'connect comes first');
  assert.match(block,/<h2[^>]*>Connect your AI agent<\/h2>/);assert.match(block,/https:\/\/room\.trydemigod\.com\/mcp/);
  assert.match(block,/href="\/docs\/agents\/paste"/);assert.match(block,/href="\/download#connect"/);
  assert.match(readFileSync(new URL('../src/styles.css',import.meta.url),'utf8'),/\.static-hero-connect \{/);
});
