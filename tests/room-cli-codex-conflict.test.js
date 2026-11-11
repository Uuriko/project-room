import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupCommand, planTool } from '../cli/commands/setup.mjs';

function fixture(t, contents) {
 const home=mkdtempSync(join(tmpdir(),'codex-conflict-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 mkdirSync(join(home,'.codex'));const path=join(home,'.codex/config.toml');writeFileSync(path,contents);
 return {home,path,env:{HOME:home,PATH:'',PROJECT_ROOM_KEYCHAIN:'0'}};
}
const conflicts = [
 'mcp_servers = { other = { url = "https://other.example" } }',
 '[mcp_servers.project-room]', '[ mcp_servers . "project-room" ] # existing', "['mcp_servers'.'project-room']",
 '["mcp_servers"."project\\u002droom"]', '["mcp_servers"."project\\U0000002droom"]',
 '[mcp_servers.project-room.headers]', '[[mcp_servers.project-room]]',
 'mcp_servers.project-room = { url = "https://old.example/mcp" }',
 '[mcp_servers]\n"project-room" = { url = "https://old.example/mcp" }',
 'mcp_servers = { other = { url = "https://other.example" }, "project-room" = { url = "https://old.example/mcp" } }',
];
for (const declaration of conflicts) test(`Codex conflict refuses before login and preserves bytes: ${declaration}`,async t=>{
 const before=`# keep exact bytes\n${declaration}\n`;
 const {home,path,env}=fixture(t,before);let requests=0;
 await assert.rejects(setupCommand(['codex','--room','https://room.example/join/SYNTHETIC','--accept'],{env,cwd:home,fetchImpl:async()=>{requests++;throw Error('must not contact Room');},out:()=>{}}),/existing.*project-room|project-room.*existing/i);
 assert.equal(requests,0);assert.equal(readFileSync(path,'utf8'),before);assert.equal(existsSync(join(home,'.project-room')),false);
 assert.throws(()=>planTool('codex',{home,project:home,url:'https://new.example/mcp'}),/project-room/i);
 await assert.rejects(setupCommand(['codex','--dry-run','--room','https://room.example'],{env,cwd:home,out:()=>{}}),/project-room/i);
 assert.equal(readFileSync(path,'utf8'),before);
});

for (const before of [
 '# [mcp_servers.project-room]\nmodel = "unchanged"\n',
 'text = """\n[mcp_servers.project-room]\n# project-room:begin\n# project-room:end\n"""\n',
 "text = '''\n[mcp_servers.project-room]\n'''\n",
 'text = "[mcp_servers.project-room]"\n[mcp_servers.other]\nurl = "https://other.example"\n',
 '[mcp_servers.project-room-other]\nurl = "https://other.example"\n',
]) test('Codex guard ignores comments, strings and unrelated server keys',t=>{
 const {home}=fixture(t,before);const args={home,project:home,url:'https://new.example/mcp'};
 const output=planTool('codex',args).files[0].contents;assert.ok(output.startsWith(before));assert.match(output,/# project-room:begin/);
});

test('managed block stays idempotent and unmanaged collision outside it refuses',t=>{
 const before='model = "keep"\n# project-room:begin\n[mcp_servers.project-room]\nurl = "https://new.example/mcp"\nbearer_token_env_var = "PROJECT_ROOM_SECRET"\n# project-room:end\n';
 const {home,path}=fixture(t,before);const args={home,project:home,url:'https://new.example/mcp'};
 assert.equal(planTool('codex',args).files[0].contents,before);
 writeFileSync(path,before+'["mcp_servers"."project-room"]\n');assert.throws(()=>planTool('codex',args),/project-room/i);
});

test('malformed or ambiguous config fails without mutation', t=>{
 for(const before of ['text = "unterminated', '# project-room:begin\n', '# project-room:end\n', 'array = [ } ]\n']) {
  const {home,path}=fixture(t,before);
  assert.throws(()=>planTool('codex',{home,project:home,url:'https://new.example/mcp'}),/project-room/i);
  assert.equal(readFileSync(path,'utf8'),before);
 }
});

test('escaped quotes and multiline closing quote variants preserve unrelated values',t=>{
 for(const before of ['text = "escaped \\\" quote"\n', 'text = """ends in a quote""""\n', "text = '''ends in a quote''''\n", 'array = ["x", { name = "other" }]\n[mcp_servers.other]\nurl = "https://other.example"\n']) {
  const {home}=fixture(t,before);const output=planTool('codex',{home,project:home,url:'https://new.example/mcp'}).files[0].contents;
  assert.ok(output.startsWith(before));
 }
});

test('config changed during login is rechecked before any tool config write',async t=>{
 const {startRoom}=await import('./room-acp-fixture.mjs');const room=await startRoom(t);
 const {home,path,env}=fixture(t,'model = "keep"\n');seedSavedConnection(home);const changed='model = "new user value"\n["mcp_servers"."project-room"]\nurl="https://user.example/mcp"\n';
 let requests=0;
 const fetchImpl=async(url,init)=>{const response=await fetch(url,init);if(++requests===1)writeFileSync(path,changed);return response;};
 await assert.rejects(setupCommand(['codex','--room',room.invite().link,'--accept'],{env,cwd:home,fetchImpl,out:()=>{}}),/Existing Codex config conflicts/);
 assert.ok(requests>0);assert.equal(readFileSync(path,'utf8'),changed);
});

test('valid Unicode escapes for quote and backslash in values are preserved', t=>{
 for (const before of ['text = "\\U00000022"\n','text = "\\U0000005c"\n']) {
  const {home}=fixture(t,before);assert.ok(planTool('codex',{home,project:home,url:'https://new.example/mcp'}).files[0].contents.startsWith(before));
 }
});

test('root mcp_servers array table refuses before login rather than nesting new server in last element',async t=>{
 const before='[[mcp_servers]]\nname="other"\n';const {home,path,env}=fixture(t,before);let requests=0;
 await assert.rejects(setupCommand(['codex','--room','https://room.example/join/SYNTHETIC','--accept'],{env,cwd:home,fetchImpl:()=>{requests++;throw Error('must not contact Room');},out:()=>{}}),/Existing Codex config conflicts/);
 assert.equal(requests,0);assert.equal(readFileSync(path,'utf8'),before);
});

test('literal escaped backslash before U and nested example tables are unrelated',t=>{
 for(const before of ['text="\\\\U0000002d"\n','examples = [{ mcp_servers = { other = { url="x" } } }]\n','examples = [{ mcp_servers.project-room.url="x" }]\n']) {
  const {home}=fixture(t,before);assert.ok(planTool('codex',{home,project:home,url:'https://new.example/mcp'}).files[0].contents.startsWith(before));
 }
});

function seedSavedConnection(home) {
 const directory=join(home,'.project-room','connections','room-agent');mkdirSync(directory,{recursive:true,mode:0o700});
 writeFileSync(join(directory,'connection.json'),JSON.stringify({version:1,origin:'https://room.example',roomId:'commons',memberId:'synthetic',token:'pri_'+'s'.repeat(43)}),{mode:0o600});
 writeFileSync(join(directory,'pointer.json'),JSON.stringify({version:1,name:'room-agent',configDirectory:directory}),{mode:0o600});
}

test('Codex setup preserves an existing private config mode',async t=>{
 const {home,path,env}=fixture(t,'model = "keep"\n');seedSavedConnection(home);
 const {chmodSync,statSync}=await import('node:fs');chmodSync(path,0o600);
 assert.equal(await setupCommand(['codex'],{env,cwd:home,out:()=>{}}),0);
 assert.equal(statSync(path).mode&0o777,0o600);assert.match(readFileSync(path,'utf8'),/model = "keep"/);
});

test('Codex config stays intact when its directory refuses staging a replacement',async t=>{
 if(process.getuid?.()===0 || process.platform==='win32')return t.skip('requires Unix directory permissions');
 const before='model = "keep exact bytes"\n',f=fixture(t,before);seedSavedConnection(f.home);
 const {chmodSync}=await import('node:fs');const directory=join(f.home,'.codex');chmodSync(directory,0o500);
 try{await assert.rejects(setupCommand(['codex'],{env:f.env,cwd:f.home,out:()=>{}}));assert.equal(readFileSync(f.path,'utf8'),before);}finally{chmodSync(directory,0o700);}
});

test('Codex preflight targets CODEX_HOME before any login or default-config change',async t=>{
 const f=fixture(t,'model = "untouched default"\n');const custom=join(f.home,'selected-codex');mkdirSync(custom);
 const config=join(custom,'config.toml'),before='[mcp_servers.project-room]\nurl="https://existing.example/mcp"\n';writeFileSync(config,before);let calls=0;
 await assert.rejects(setupCommand(['codex','--room','https://room.example/join/SYNTHETIC','--accept'],{env:{...f.env,CODEX_HOME:custom},cwd:f.home,fetchImpl:async()=>{calls++;throw Error('unexpected login');},out:()=>{}}),/project-room/i);
 assert.equal(calls,0);assert.equal(readFileSync(config,'utf8'),before);assert.equal(readFileSync(f.path,'utf8'),'model = "untouched default"\n');
 writeFileSync(config,'model = "selected custom"\n');seedSavedConnection(f.home);
 assert.equal(await setupCommand(['codex'],{env:{...f.env,CODEX_HOME:custom},cwd:f.home,out:()=>{}}),0);
 assert.match(readFileSync(config,'utf8'),/model = "selected custom"/);assert.match(readFileSync(config,'utf8'),/mcp_servers.project-room/);
 assert.equal(readFileSync(f.path,'utf8'),'model = "untouched default"\n');
});
