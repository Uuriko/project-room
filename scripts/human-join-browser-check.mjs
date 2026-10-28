import test from "node:test";
import assert from "node:assert/strict";
import {rmSync} from "node:fs";
import {chromium} from "playwright";
import {createAcceptanceFixture} from "./acceptance-fixture.mjs";
import {createRoomServer} from "../server/http.mjs";
import {hashPassword} from "../src/password-auth.mjs";
import {signInFixtureInPlace} from "./in-place-fixture-signin.mjs";
for(const [width,decision] of [[1280,"Approve"],[390,"Approve"],[390,"Decline"]]) test(`human join request reaches owner and ${decision} reaches account at width ${width}`,async t=>{
 const f=createAcceptanceFixture(),s=f.store;s.roomDirectory.set("commons","owner",true);
 s.createAccount("browser-human");s.completeOnboarding("browser-human");s.accountLogins.linkPasswordMethod("browser-human",{email:"joiner@example.invalid",verifier:hashPassword("synthetic-human-join")});
 const server=createRoomServer({store:s});await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});
 t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));s.close();rmSync(f.directory,{recursive:true,force:true});});
 const owner=await browser.newPage({viewport:{width,height:900}});owner.setDefaultTimeout(10000);
 await owner.goto(origin);await signInFixtureInPlace(owner,s,f.keys.owner);
 const context=await browser.newContext({viewport:{width,height:900}});
 const requester=await context.newPage();requester.setDefaultTimeout(10000);
 await requester.goto(origin);
 await requester.getByRole("button",{name:"Log in",exact:true}).click();
 const login=requester.locator('#auth-signin-ui [data-signin-form="password"]');
 await login.locator('[name="email"]').fill("joiner@example.invalid");await login.locator('[name="password"]').fill("synthetic-human-join");await login.locator('button[type="submit"]').click();
 await requester.locator("#room-choice-discover").click();
 await requester.locator(".room-discovery-entry").filter({hasText:"Disposable Test"}).getByRole("button",{name:"Request access",exact:true}).click();
 await requester.locator("#account-human-join").getByLabel("Your name",{exact:true}).fill("Browser Joiner");const sent=requester.waitForResponse(r=>r.url().endsWith("/api/account-join-requests")&&r.request().method()==="POST");await requester.locator("#account-human-join").getByRole("button",{name:"Request access",exact:true}).click();
 const filed=await sent;assert.equal(filed.status(),201,await filed.text());
 await requester.getByText("commons · Waiting for approval",{exact:true}).waitFor();
 await owner.waitForFunction(()=>Number(document.querySelector("#updates-count").textContent)>0);
 if(decision==="Decline"){await owner.reload();await owner.locator("#main").waitFor({state:"visible"});}
 await owner.locator("#topbar-updates").click();
 const item=owner.locator('[data-access-request-id]').filter({hasText:"Browser Joiner asks to join"});
 await item.getByRole("button",{name:decision,exact:true}).click();
 await requester.getByRole("button",{name:"Refresh status",exact:true}).click();
 if(decision==="Decline"){await requester.getByText("commons · Request declined",{exact:true}).waitFor();assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM member_accounts WHERE account_id='browser-human'").get().n,0);return;}
 await requester.getByRole("button",{name:"Open room",exact:true}).click();
 await requester.locator("#main").waitFor({state:"visible"});
 assert.match(await requester.locator("#room-title").innerText(),/Disposable Test/);
 assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM member_accounts WHERE account_id='browser-human' AND room_id='commons'").get().n,1);
 assert.equal(await requester.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await owner.locator("#updates-close").click();
 if(!await owner.locator("#topbar-settings").isVisible())await owner.locator("#room-more > summary").click();
 await owner.locator("#topbar-settings").click();
 const visibility=owner.locator('#settings-dialog .settings-group').filter({has:owner.locator('#settings-group-room')}).locator('#room-discovery-select');
 await visibility.selectOption("private");await owner.locator("#room-discovery-settings-status").getByText("Saved",{exact:true}).waitFor();
 assert.equal(s.roomDirectory.status("commons","owner").discoverable,false);
 assert.equal(s.publicFace.status("commons","owner").enabled,false);

});

test("human request refresh ignores older same-account results and errors across mutations",async t=>{
 const f=createAcceptanceFixture(),server=createRoomServer({store:f.store});await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result=await page.evaluate(async()=>{
  const {createHumanJoinUI}=await import('/src/human-join-ui.js');
  const container=document.createElement('div');document.body.append(container);const calls=[];
  const client={session:{authenticated:true},request:(path,options)=>new Promise((resolve,reject)=>calls.push({path,options,resolve,reject}))};
  const ui=createHumanJoinUI({accountClient:client,container});
  const row=status=>({requestId:'humanjoin-race',roomId:'commons',status,revision:status==='pending'?0:1});
  const old=ui.refresh(),fresh=ui.refresh();calls[1].resolve({requests:[row('approved')]});await fresh;calls[0].resolve({requests:[row('pending')]});await old;
  const olderResult=container.textContent;
  const failed=ui.refresh(),newer=ui.refresh();calls[3].resolve({requests:[row('approved')]});await newer;calls[2].reject(new Error('old failure'));await failed;
  const olderError=container.querySelector('[role="alert"]')?.textContent??null;
  ui.open('commons','Commons');const initial=calls.at(-1);initial.resolve({requests:[]});await new Promise(r=>setTimeout(r,0));
  const beforeSubmit=ui.refresh(),submitRead=calls.at(-1);container.querySelector('[name="displayName"]').value='Human';container.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  submitRead.resolve({requests:[row('approved')]});await beforeSubmit;const duringSubmit=container.querySelector('[data-join-status]')?.textContent??'';
  ui.reset();const staleAfterReset=ui.refresh(); // unauthenticated owner is reselected only for the same explicit session
  calls.at(-1).resolve({requests:[row('pending')]});await staleAfterReset;
  const beforeCancel=ui.refresh(),cancelRead=calls.at(-1);[...container.querySelectorAll('button')].find(b=>b.textContent==='Cancel request').click();
  cancelRead.resolve({requests:[row('approved')]});await beforeCancel;const duringCancel=container.querySelector('[data-join-status]')?.textContent??'';
  const obsolete=ui.refresh(),obsoleteRead=calls.at(-1);ui.reset();client.session={authenticated:true};const nextAccount=ui.refresh();calls.at(-1).resolve({requests:[]});await nextAccount;obsoleteRead.resolve({requests:[row('approved')]});await obsolete;const afterAccountSwitch=container.textContent;
  ui.reset();return {olderResult,olderError,duringSubmit,duringCancel,afterAccountSwitch};
 });
 assert.match(result.olderResult,/Open room/);assert.doesNotMatch(result.olderResult,/Waiting for approval|Cancel request/);
 assert.equal(result.olderError,null);assert.equal(result.duringSubmit,'');assert.doesNotMatch(result.duringCancel,/Open room/);assert.doesNotMatch(result.afterAccountSwitch,/Open room|commons/);
});
