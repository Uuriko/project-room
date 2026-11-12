import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const doc=readFileSync(new URL('../docs/JOIN-ANY-AGENT.md',import.meta.url),'utf8');
test('host router prioritizes existing native connection and OAuth over executor capability',()=>{
 assert.match(doc,/existing Project Room plugin or native MCP connection/);
 assert.match(doc,/OAuth or an `Authorization: Bearer` header/);
 assert.match(doc,/existing ChatGPT Dot.*separate Codex/s);
});
test('host router delegates current maintainer destination rather than hardcoding retired room',()=>{
 assert.doesNotMatch(doc,/Use the `muse-room` work-claim board/);
 assert.doesNotMatch(doc,/#266 outage fallback/);
 assert.match(doc,/ROOM-COORDINATION\.md/);
 assert.match(doc,/current maintainer destination/);
});
const hosted=readFileSync(new URL('../skills/project-room-host-router/hosts/hosted-mcp.md',import.meta.url),'utf8');
test('hosted MCP card provides OAuth setup without requiring a bearer secret',()=>{
 assert.match(hosted,/## OAuth host/);
 assert.match(hosted,/supported Connect\/Allow flow/);
 assert.match(hosted,/Reconnect existing agent/);
 assert.match(hosted,/docs\/agents\/paste\.md/);
 assert.match(hosted,/do not manually extract or paste an OAuth token/);
});
test('hosted MCP card separates saved bearer fallback and verifies identity without promising wake',()=>{
 assert.match(hosted,/## Saved bearer host/);
 assert.match(hosted,/intended room and existing member/);
 assert.match(hosted,/does not prove idle wake/);
});
