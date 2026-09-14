import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

for(const width of [390,1280])test(`receiving consent is disclosed, stoppable and owner-fenced at ${width}px`,async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:844}});
  await page.setContent('<div id="list"></div><p id="status" role="status"></p>');
  const code=readFileSync(new URL('../src/messaging-connections-ui.js',import.meta.url)).toString('base64');
  await page.evaluate(async code=>{
    const {installMessagingConnections}=await import('data:text/javascript;base64,'+code);
    window.owner='a';window.calls=[];
    window.permission={provider:'sms',connectionId:'one',state:'missing',revision:0,expectedConnectionRevision:1,expiresAt:null,canStart:true};
    window.api={twilioStatus:async()=>({connections:[{provider:'sms',connectionId:'one',state:'active',revision:1}]}),
      receivingStatus:async()=>({enabled:true,connections:[window.permission]}),receivingAction:async(action,data)=>{
        window.calls.push({action,data});window.permission={...window.permission,revision:data.expectedRevision+1,state:action==='start'?'active':'revoked',expiresAt:Date.now()+86400000};
      }};
    window.controls=installMessagingConnections({list:document.querySelector('#list'),status:document.querySelector('#status'),api:window.api,ownerKey:()=>window.owner});
    await window.controls.load();
  },code);
  const allow=page.getByRole('button',{name:'Allow for 24 hours · SMS',exact:true});
  assert.equal(await allow.isVisible(),false);
  await page.getByText('Receiving',{exact:true}).click();
  assert.equal(await page.getByText('Allow incoming messages for 24 hours, even after sign-out. No sending or sharing.',{exact:true}).isVisible(),true);
  await allow.click();await page.getByText('Receiving allowed for 24 hours.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls),[{action:'start',data:{connectionId:'one',expectedRevision:0,expectedConnectionRevision:1}}]);
  await page.getByText('Receiving',{exact:true}).click();
  const allowedCopy=await page.locator('body').textContent();
  assert.ok(!allowedCopy.includes('Invalid Date'));
  assert.match(allowedCopy,/Allowed until /);
  await page.getByRole('button',{name:'Stop receiving · SMS',exact:true}).click();
  await page.getByText('Receiving stopped. Saved messages remain.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Disconnect SMS',exact:true}).count(),1);
  await page.getByText('Receiving',{exact:true}).click();
  await page.evaluate(()=>window.owner='b');await allow.click();
  assert.equal(await page.evaluate(()=>window.calls.length),2);
  await page.evaluate(()=>{window.owner='a';window.api.receivingAction=async()=>{throw new Error('private detail');};});
  await allow.click();await page.getByText('Action unconfirmed. Refresh before trying again.',{exact:true}).waitFor();
  assert.equal(await allow.count(),0);
  assert.ok(!(await page.locator('body').textContent()).includes('private detail'));
});

for(const width of [390,1280])test(`compact messaging controls: disconnect and late owner responses at ${width}px`,async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:844}});
  await page.setContent('<details><summary>Connections</summary><div id="list"></div><p id="status" role="status"></p></details>');
  const code=readFileSync(new URL('../src/messaging-connections-ui.js',import.meta.url)).toString('base64');
  await page.evaluate(async code=>{
    const {installMessagingConnections}=await import('data:text/javascript;base64,'+code);
    window.owner='a';window.calls=[];window.rows=[{provider:'sms',connectionId:'one',state:'active',revision:1},{provider:'whatsapp',connectionId:'two',state:'active',revision:1}];
    window.api={twilioStatus:async()=>({connections:window.rows}),twilioDisconnect:async data=>{window.calls.push(data);window.rows=window.rows.map(c=>c.connectionId===data.connectionId?{...c,state:'disconnected',revision:2}:c);}};
    window.controls=installMessagingConnections({list:document.querySelector('#list'),status:document.querySelector('#status'),api:window.api,ownerKey:()=>window.owner});
    await window.controls.load();
  },code);
  assert.equal(await page.getByRole('button',{name:'Disconnect SMS'}).isVisible(),false);
  await page.locator('summary').click();await page.getByRole('button',{name:'Disconnect SMS',exact:true}).click();
  await page.getByText('Disconnected here. Saved messages remain.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls),[{connectionId:'one',expectedRevision:1}]);
  assert.equal(await page.getByRole('button',{name:'Disconnect SMS',exact:true}).count(),0);
  // Even before the host clears old markup, a button from another owner must
  // not issue a disconnect against a coincidentally identical connection ID.
  await page.evaluate(()=>{window.owner='other';});
  await page.getByRole('button',{name:'Disconnect WhatsApp',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.calls.length),1);
  await page.evaluate(()=>{window.owner='a';});
  await page.evaluate(()=>{window.api.twilioStatus=()=>new Promise(resolve=>window.finish=resolve);window.pending=window.controls.load();});
  await page.evaluate(async()=>{window.owner='b';window.controls.reset();window.finish({connections:window.rows});await window.pending;});
  assert.equal(await page.locator('#list').textContent(),'');assert.equal(await page.locator('#status').textContent(),'');
  await page.evaluate(()=>{window.api.twilioStatus=async()=>({connections:window.rows});});
  await page.evaluate(()=>window.controls.load());
  await page.evaluate(()=>{window.api.twilioDisconnect=()=>new Promise(resolve=>window.finishDisconnect=resolve);});
  await page.getByRole('button',{name:'Disconnect WhatsApp',exact:true}).click();
  await page.evaluate(()=>{window.owner=null;window.controls.reset();window.finishDisconnect({});});
  await page.waitForTimeout(30);
  assert.equal(await page.locator('#list').textContent(),'');assert.equal(await page.locator('#status').textContent(),'');
});

test('confirmed disconnect stays confirmed when refresh fails; uncertain action never claims success',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.setContent('<div id="list"></div><p id="status" role="status"></p>');
  const code=readFileSync(new URL('../src/messaging-connections-ui.js',import.meta.url)).toString('base64');
  await page.evaluate(async code=>{
    const {installMessagingConnections}=await import('data:text/javascript;base64,'+code);
    window.rows=[{provider:'sms',connectionId:'one',state:'active',revision:1}];window.rejectStatus=false;
    window.api={twilioStatus:async()=>{if(window.rejectStatus)throw new Error('private server detail');return {connections:window.rows};},
      twilioDisconnect:async()=>{window.rejectStatus=true;}};
    window.controls=installMessagingConnections({list:document.querySelector('#list'),status:document.querySelector('#status'),api:window.api,ownerKey:()=> 'a'});
    await window.controls.load();
  },code);
  await page.getByRole('button',{name:'Disconnect SMS',exact:true}).click();
  await page.getByText('Disconnected here. Saved messages remain.',{exact:true}).waitFor();
  assert.equal(await page.locator('#list').textContent(),'');
  await page.evaluate(()=>{window.rejectStatus=false;window.api.twilioDisconnect=async()=>{throw new Error('private server detail');};return window.controls.load();});
  await page.getByRole('button',{name:'Disconnect SMS',exact:true}).click();
  await page.getByText('Action unconfirmed. Refresh before trying again.',{exact:true}).waitFor();
  assert.ok(!(await page.locator('body').textContent()).includes('private server detail'));
  assert.equal(await page.getByRole('button',{name:'Disconnect SMS',exact:true}).count(),0);
  await page.getByRole('button',{name:'Refresh messaging connections',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Disconnect SMS',exact:true}).isEnabled(),true);
});
