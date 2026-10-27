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
