// Synthetic browser coverage for an authentication response lost after commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';

for (const otherAccount of [false,true]) {
  test(`uncertain login reconciles draft for ${otherAccount?'another':'the same'} account`, {timeout:30000}, async t => {
    const dir=mkdtempSync(join(tmpdir(),'draft-uncertain-'));
    const store=new RoomStore(join(dir,'room.sqlite'));
    const owner=store.createAccount('draft-owner');store.completeOnboarding(owner.id);
    const slot=store.createAccountSessionSlot();
    let active=store.loginAccountSessionWithMethod(slot.token,owner.id,0,{method:{kind:'fixture'},rotateSlot:true});
    store.createAccountRoom(active.token,active.session.sessionBinding,{roomId:'draft-test',title:'Draft test',purpose:'Synthetic fixture',kind:'personal',displayName:'Tester'});
    const other=store.createAccount('draft-other');store.completeOnboarding(other.id);
    const ownerId=store.authenticateAccountSession(active.token,'draft-test').member.id;
    const ownerKey=store.issueAccessKey('draft-test',ownerId);
    store.command(ownerKey,'draft-test',{id:'add-other',type:'member.added',data:{memberId:'other-member',displayName:'Other',kind:'human',permissions:[]}});
    store.issueAccessKey('draft-test','other-member',86400000,other.id);
    const server=createRoomServer({store,streamInterval:50});
    const handler=server.listeners('request')[0];server.removeAllListeners('request');
    let uncertainCalls=0;
    server.on('request',(req,res)=>{
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/fixture/login') {res.writeHead(302,{'Set-Cookie':`account_session=${active.token}; Path=/; SameSite=Lax`,Location:'/?room=draft-test'});res.end();return;}
      if(path==='/fixture/rotate') {active=store.loginAccountSessionWithMethod(active.token,owner.id,active.session.sessionRevision,{method:{kind:'fixture'},rotateSlot:true});res.writeHead(200,{'Set-Cookie':`account_session=${active.token}; Path=/; SameSite=Lax`});res.end('rotated');return;}
      if(path==='/api/auth/password/login') {uncertainCalls++;active=store.loginAccountSessionWithMethod(active.token,otherAccount?other.id:owner.id,active.session.sessionRevision,{method:{kind:'fixture'},rotateSlot:true});res.writeHead(200,{'Set-Cookie':`account_session=${active.token}; Path=/; SameSite=Lax`,'Content-Type':'application/json'});res.end('{}');return;}
      handler(req,res);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await chromium.launch({headless:true});
    t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
    const context=await browser.newContext(),page=await context.newPage();
    const origin=`http://127.0.0.1:${server.address().port}`;
    await page.goto(origin+'/fixture/login');
    await page.getByText('Connected',{exact:true}).waitFor({state:'visible'});
    await page.locator('#message-input').fill('synthetic private draft');
    await page.waitForFunction(()=>sessionStorage.getItem('project-room:drafts:v3')?.includes('synthetic private draft'));
    const second=await context.newPage();await second.goto(origin+'/fixture/rotate');await second.close();
    await page.locator('#auth-panel input[type=email]').waitFor({state:'visible'});
    await page.locator('#auth-panel input[type=email]').fill('fixture@example.com');
    await page.locator('#auth-panel input[type=password]').fill('synthetic-password');
    await page.locator('#auth-panel input[type=password]').press('Enter');
    await page.locator('#account-rooms-panel').waitFor({state:'visible'});
    assert.equal(uncertainCalls,1,'fixture committed login but returned malformed response');
    if(otherAccount) {
      assert.equal(await page.evaluate(()=>sessionStorage.getItem('project-room:drafts:v3')),null,'old account backup cleared before opening a room');
    } else {
      await page.getByRole('button',{name:'Open Draft test'}).click();
      await page.waitForFunction(()=>document.querySelector('#message-input')?.value==='synthetic private draft');
      assert.equal(await page.locator('#message-input').inputValue(),'synthetic private draft');
    }
  });
}
