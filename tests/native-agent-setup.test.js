import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeConnect, nativeLogin, providerLoginURL } from "../client/native-agent-setup.mjs";
import { openCodexStdio } from "../client/codex-stdio.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

function runtime(t, mode = "success") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-login-"))), cwd = join(root, "workspace"), codexHome = join(root, "profile");
  mkdirSync(cwd); mkdirSync(codexHome, { mode: 0o700 });
  const command = join(root, "provider.mjs");
  writeFileSync(command, `#!${process.execPath}\nimport {createInterface} from 'node:readline';
let authenticated=false;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
if(m.method==='initialize'&&${JSON.stringify(mode)}==='hang')return;
if(m.method==='initialize'){send({id:m.id,result:{}});return;}
if(m.method==='account/read'){send({id:m.id,result:{account:authenticated?{id:'fixture'}:null,requiresOpenaiAuth:true}});return;}
if(m.method==='account/login/start'){send({id:m.id,result:{type:'chatgpt',loginId:'owned',authUrl:'https://auth.openai.com/authorize?state=fixture'}});
send({method:'account/login/completed',params:{loginId:'foreign',success:true}});
if(${JSON.stringify(mode)}==='exit')setTimeout(()=>process.exit(4),30);
if(${JSON.stringify(mode)}==='success')setTimeout(()=>{authenticated=true;send({method:'account/login/completed',params:{loginId:'owned',success:true}})},30);return;}
if(m.method==='account/login/cancel'){send({id:m.id,result:{}});return;}
send({id:m.id,error:{code:-32601}});});\n`, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { command, cwd, codexHome, policy: { approvalPolicy: "never", sandbox: "read-only" }, requestTimeoutMs: 1000 };
}
test("native login uses owned subprocess completion and closes private profile lock", async t => {
  const config = runtime(t), events = [];
  const result = await nativeLogin(config, { emit: event => events.push(event), timeoutMs: 2000 });
  assert.deepEqual(result, { status: "credentials_present", modelExecution: "not_tested" });
  assert.equal(events[0].status, "open_browser");
  assert.equal(events.length, 1);
  assert.equal(existsSync(join(config.codexHome, ".room-runtime.lock")), false);
});
test("foreign login completion cannot authenticate; timeout cancels and releases profile", async t => {
  const config = runtime(t, "wait");
  assert.deepEqual(await nativeLogin(config, { timeoutMs: 150 }), { status: "timeout" });
  assert.equal(existsSync(join(config.codexHome, ".room-runtime.lock")), false);
});
test("cancel pending browser login cleans up the owned provider process", async t => {
  const config = runtime(t, "wait"), controller = new AbortController();
  const result = await nativeLogin(config, { signal: controller.signal, emit: () => controller.abort() });
  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(existsSync(join(config.codexHome, ".room-runtime.lock")), false);
});
test("authentication session cannot execute, import tokens or cancel foreign login", async t => {
  const config = runtime(t), rpc = openCodexStdio(config, { authenticationOnly: true });
  t.after(() => rpc.close());
  await rpc.request("initialize", {});
  await assert.rejects(rpc.request("thread/start", {}), /outside/);
  await assert.rejects(rpc.request("turn/start", {}), /outside/);
  await assert.rejects(rpc.request("account/login/start", { type: "apiKey", apiKey: "fixture" }), /explicit browser/);
  await assert.rejects(rpc.request("account/login/cancel", { loginId: "foreign" }), /outside/);
  await rpc.close();
  const ordinary = openCodexStdio(config); t.after(() => ordinary.close());
  await assert.rejects(ordinary.request("account/login/start", { type: "chatgpt" }), /outside/);
});
test("provider browser URL rejects credential URLs and lookalike origins", () => {
  for (const url of ["http://auth.openai.com/", "https://auth.openai.com.evil.invalid/", "https://x@auth.openai.com/", "file:///tmp/login", "https://auth.openai.com:8443/"])
    assert.throws(() => providerLoginURL(url));
  assert.equal(providerLoginURL("https://chatgpt.com/auth"), "https://chatgpt.com/auth");
});
test("native invitation preview and acceptance connect once without disclosing credential", async t => {
  const root = mkdtempSync(join(tmpdir(), "native-join-")), store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const owner = store.issueAccessKey("commons", "owner"), invite = store.invites.create(owner, "commons", { profile: "chat", displayName: "Peer" });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  const input = { target: `http://127.0.0.1:${server.address().port}/join/${invite.code}`, directory: join(root, "enrollment") };
  const preview = await nativeConnect(input); assert.equal(preview.status, "approval_required");
  await assert.rejects(nativeConnect({ ...input, accept: true, expectedPreview: "changed" }), /Invitation changed/);
  const connected = await nativeConnect({ ...input, accept: true, expectedPreview: preview.expectedPreview });
  assert.equal(connected.status, "connected"); assert.equal(connected.execution, "not_tested");
  assert.equal(JSON.stringify(connected).includes("rak_"), false); assert.equal(JSON.stringify(connected).includes("pri_"), false);
  const again = await nativeConnect(input);
  assert.deepEqual(again, connected);
  assert.equal(store.db.prepare("SELECT count(*) n FROM agent_identities").get().n, 1);
});

test("provider exit while browser login is pending ends the attempt promptly", async t => {
  const config = runtime(t, "exit");
  assert.deepEqual(await nativeLogin(config, { timeoutMs: 10000 }), { status: "login_failed" });
  assert.equal(existsSync(join(config.codexHome, ".room-runtime.lock")), false);
});

test("Cancel interrupts a stalled provider handshake rather than waiting for RPC timeout", async t => {
  const config = runtime(t, "hang"), controller = new AbortController();
  config.requestTimeoutMs = 10000;
  const timer = setTimeout(() => controller.abort(), 100); t.after(() => clearTimeout(timer));
  const start = Date.now();
  assert.deepEqual(await nativeLogin(config, { signal: controller.signal }), { status: "cancelled" });
  assert.ok(Date.now() - start < 5000);
  assert.equal(existsSync(join(config.codexHome, ".room-runtime.lock")), false);
});
