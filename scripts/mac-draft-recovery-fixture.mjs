// Only a loopback server, a disposable in-memory store and one synthetic session.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";

const [binary] = process.argv.slice(2);
if (!binary || !isAbsolute(binary) || process.argv.length !== 3) throw Error("fixture_binary_required");

const account = "draft-fixture-account", member = "owner";
const a = { id: "draft-fixture-a", title: "Native draft fixture A", nonce: randomUUID() };
const b = { id: "draft-fixture-b", title: "Native draft fixture B", nonce: randomUUID() };
const sentinel = randomUUID();
const dir = await mkdtemp(join(tmpdir(), "room-draft-fixture-"));
const store = new RoomStore(":memory:");
let server;

const shared = (room) => `
const target = ${JSON.stringify(room)};
const accountId = ${JSON.stringify(account)};
const wait = async (predicate, label) => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(label);
};
const check = (value, label) => { if (!value) throw Error(label); };
const composer = () => document.querySelector("#message-input");
await wait(() => document.querySelector("#room-title")?.textContent === target.title &&
  !document.querySelector("#main")?.hidden && composer()?.getClientRects().length && !composer()?.disabled,
  "fixture_room_not_hydrated");
const session = await fetch("/api/account-session").then(response => response.json());
check(session.account?.id === accountId, "fixture_account_changed");
const retained = () => JSON.parse(localStorage.getItem("project-room:drafts:v3") ?? "null");
const written = () => {
  const record = retained();
  return record && JSON.parse(record.scope)[0] === target.id &&
    JSON.parse(record.scope)[1] === accountId && record.entries.some(([, draft]) => draft.body === target.nonce);
};
const sameStore = () => check(localStorage.getItem("native-draft-fixture-store") === ${JSON.stringify(sentinel)}, "fixture_store_changed");
const writeDraft = () => {
  composer().value = target.nonce;
  composer().dispatchEvent(new Event("input", { bubbles: true }));
};
`;
const writeA = shared(a) + `
localStorage.setItem("native-draft-fixture-store", ${JSON.stringify(sentinel)});
check(composer().value === "", "fixture_initial_draft_present");
writeDraft();
await wait(written, "draft_a_not_written_to_its_scope");
return "DRAFT_A_STORED";
`;
const restore = (room, marker) => shared(room) + `
sameStore();
await wait(() => composer().value === target.nonce, "draft_not_restored_after_new_document");
check(written(), "draft_restored_from_wrong_scope");
return ${JSON.stringify(marker)};
`;
const writeB = shared(b) + `
sameStore();
check(composer().value === "", "draft_a_leaked_into_b");
check(!retained()?.entries.some(([, draft]) => draft.body === ${JSON.stringify(a.nonce)}), "draft_a_retained_in_scope_b");
writeDraft();
await wait(written, "draft_b_not_written_to_its_scope");
return "DRAFT_A_EXCLUDED_FROM_B";
`;
const returnA = shared(a) + `
sameStore();
check(composer().value === "", "draft_b_leaked_into_a");
check(!retained()?.entries.some(([, draft]) => draft.body === ${JSON.stringify(b.nonce)}), "draft_b_retained_in_scope_a");
return "DRAFT_B_EXCLUDED_FROM_A";
`;

try {
  store.createAccount(account);
  for (const room of [a,b]) {
    const events = initialRoom(room.id,member);
    events[0].data.title = room.title;
    store.initialize(events);
    store.bindHumanAccount(room.id,member,account);
  }
  const slot = store.createAccountSessionSlot();
  store.loginAccountSession(slot.token,store.issueAccountAccessKey(account),0);
  // The isolated acceptance run hydrates five documents without user think time.
  server = createRoomServer({store, credentialReadBurst:250});
  const route = server.listeners("request")[0];
  server.removeListener("request",route);
  server.on("request",(req,res) => {
    if (req.method !== "GET" || req.url !== "/draft-fixture-start") return route(req,res);
    res.writeHead(302,{ Location: `/?room=${a.id}`,
      "Set-Cookie": `account_session=${slot.token}; Path=/; HttpOnly; SameSite=Strict` }).end();
  });
  await new Promise((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function step(name, code) {
    const file = join(dir,name+".js");
    await writeFile(file,code,{mode:0o600});
    return file;
  }
  const child = spawn(binary, [origin+"/draft-fixture-start",await step("a-write",writeA),
    "--after-reload",await step("a-restore",restore(a,"DRAFT_A_RESTORED")),
    "--navigate",origin+`/?room=${b.id}`,await step("b-write",writeB),
    "--navigate",origin+`/?room=${b.id}&fixtureDocument=2`,await step("b-restore",restore(b,"DRAFT_B_RESTORED")),
    "--navigate",origin+`/?room=${a.id}`,await step("a-return",returnA)],{stdio:["ignore","pipe","pipe"]});
  let output="", errors="";
  child.stdout.setEncoding("utf8").on("data",x=>{output=(output+x).slice(-8192);});
  child.stderr.setEncoding("utf8").on("data",x=>{errors=(errors+x).slice(-8192);});
  const timer=setTimeout(()=>child.kill("SIGKILL"),85_000);
  let code;
  try { code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);}); }
  finally { clearTimeout(timer); }
  const checks = {
    roomADraftStored: /^WK_ACCEPTANCE .*DRAFT_A_STORED/m.test(output),
    roomARestoredOnReload: /^WK_RELOAD_ACCEPTANCE .*DRAFT_A_RESTORED/m.test(output),
    roomAExcludedFromB: /^WK_NAVIGATION_ACCEPTANCE .*DRAFT_A_EXCLUDED_FROM_B/m.test(output),
    roomBRestoredOnFreshNavigation: /^WK_NAVIGATION_ACCEPTANCE .*DRAFT_B_RESTORED/m.test(output),
    roomBExcludedFromA: /^WK_NAVIGATION_ACCEPTANCE .*DRAFT_B_EXCLUDED_FROM_A/m.test(output)
  };
  const passed=code===0 && Object.values(checks).every(Boolean);
  console.log("ROOM_DRAFT_FIXTURE "+JSON.stringify({ status:passed?"passed":"failed", checks,
    sameSyntheticAccountAndBrowserStore:passed, exitCode:code }));
  if(!passed){const safe=errors.match(/(?:fixture|draft)_[a-z_]+/g) ?? [];console.error(safe.join(" "));process.exitCode=1;}
} finally {
  if(server?.listening){server.closeStreams();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
  store.close();
  await rm(dir,{recursive:true,force:true});
}
