import test from "node:test";
import assert from "node:assert/strict";
import {rmSync} from "node:fs";
import {chromium} from "playwright";
import {createAcceptanceFixture} from "./acceptance-fixture.mjs";
import {createRoomServer} from "../server/http.mjs";
import {signInFixtureInPlace} from "./in-place-fixture-signin.mjs";
for(const [width,decision] of [[1280,"Approve"],[390,"Approve"],[390,"Decline"]]) test(`human join request reaches owner and ${decision} reaches account at width ${width}`,async t=>{
 const f=createAcceptanceFixture(),s=f.store;s.roomDirectory.set("commons","owner",true);
 s.createAccount("browser-human");const slot=s.createAccountSessionSlot();s.loginAccountSession(slot.token,s.issueAccountAccessKey("browser-human"),0);
 const server=createRoomServer({store:s});await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});
 t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));s.close();rmSync(f.directory,{recursive:true,force:true});});
 const owner=await browser.newPage({viewport:{width,height:900}});owner.setDefaultTimeout(10000);
 await owner.goto(origin);await signInFixtureInPlace(owner,s,f.keys.owner);
 const context=await browser.newContext({viewport:{width,height:900}});await context.addCookies([{name:"account_session",value:slot.token,url:origin,httpOnly:true,sameSite:"Strict"}]);
 const requester=await context.newPage();requester.setDefaultTimeout(10000);
 await requester.route(origin+"/human-join-fixture",route=>route.fulfill({contentType:"text/html",body:'<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/src/styles.css"><main><section id="join"></section></main>'}));
 await requester.goto(origin+"/human-join-fixture");
 await requester.evaluate(async()=>{const {AccountClient}=await import("/src/account-client.js");const {createHumanJoinUI}=await import("/src/human-join-ui.js");const c=new AccountClient();await c.restore();window.joinUI=createHumanJoinUI({accountClient:c,container:document.querySelector("#join"),onJoined:id=>{window.openedRoom=id;}});window.joinUI.open("commons","Test room");});
 await requester.getByLabel("Your name").fill("Browser Joiner");const sent=requester.waitForResponse(r=>r.url().endsWith("/api/account-join-requests")&&r.request().method()==="POST");await requester.getByRole("button",{name:"Request access",exact:true}).click();
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
 assert.equal(await requester.evaluate(()=>window.openedRoom),"commons");
 assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM member_accounts WHERE account_id='browser-human' AND room_id='commons'").get().n,1);
 assert.equal(await requester.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});
