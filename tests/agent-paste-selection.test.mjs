import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,cpSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentPages,PASTE_PAGE} from '../scripts/build-agent-docs.mjs';
const decode=s=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
test('paste prompt is exact readonly labeled native selection field; other docs retain code blocks',()=>{
 const actual=[...readFileSync(new URL('../docs/agents/paste.md',import.meta.url),'utf8').matchAll(/```text\n([\s\S]*?)\n```/g)].map(m=>m[1]);
 const htmlActual=agentPages().get(PASTE_PAGE.htmlFile),generated=[...htmlActual.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)];assert.equal(generated.length,actual.length);assert.deepEqual(generated.map(m=>decode(m[2])),actual);
 const ids=generated.map(m=>/id="([^"]+)"/.exec(m[1])[1]);assert.equal(new Set(ids).size,actual.length);for(const id of ids)assert.match(htmlActual,new RegExp('<label class="agent-paste-label" for="'+id+'">[^<]+</label>'));
 assert.match(htmlActual,/>Copy this prompt into your agent: Optional: join a specific room<\/label>/);assert.match(htmlActual,/>Copy this prompt into your agent: Agent with direct HTTP access<\/label>/);
 const dir=mkdtempSync(join(tmpdir(),'paste-selection-'));
 try{
 cpSync(new URL('../docs/agents/',import.meta.url),dir,{recursive:true});
 const file=join(dir,'paste.md'),original=readFileSync(file,'utf8');
 const prompt='Exact <tag> & "quoted" prompt\n\n</textarea><script>not executable</script>\nFinal line';
 writeFileSync(file,original.replace(/```text\n[\s\S]*?\n```/,'```text\n'+prompt+'\n```'));
 const pages=agentPages(dir),html=pages.get(PASTE_PAGE.htmlFile),field=/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/.exec(html);assert.ok(field);assert.match(field[1],/readonly/);assert.match(field[1],/rows="4"/);assert.match(field[1],/id="agent-paste-prompt-1"/);assert.match(html,/<label class="agent-paste-label" for="agent-paste-prompt-1">Copy this prompt into your agent: Start with this prompt<\/label>/);assert.equal(decode(field[2]),prompt);assert.doesNotMatch(html,/<script>not executable/);assert.equal((html.match(/<textarea\b/g)||[]).length,actual.length);assert.doesNotMatch(html,/<pre\b/);
 for(const [name,page] of pages)if(name!==PASTE_PAGE.htmlFile){assert.doesNotMatch(page,/<textarea\b/);if(name!=='docs/agents/index.html')assert.match(page,/<pre tabindex="0"/);}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
