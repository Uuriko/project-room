import test from 'node:test';
import assert from 'node:assert/strict';
import { runHumanHome } from '../scripts/onboarding-probe/human-home.mjs';
import { pathMetric } from '../scripts/onboarding-probe/gate.mjs';

function browserFixture({roomVisible=true}={}) {
  const calls=[];
  const locator={locator:()=>locator,click:async()=>{},fill:async()=>{},waitFor:async()=>{}};
  const browser={newPage:async()=>({
    goto:async()=>{},locator:()=>locator,
    getByText:text=>({waitFor:async()=>{if(text!=='My first room'||!roomVisible)throw new Error('not visible');}}),
    context:()=>({request:{get:async url=>{calls.push(url);return {json:async()=>url.includes('account-session')?{sessionBinding:'synthetic-binding',csrf:'synthetic-csrf'}:{rooms:[{id:'qa-only'}]}};}},cookies:async()=>[]}),
    close:async()=>{}
  }),close:async()=>{}};
  return {browser,calls};
}

test('visible first room without a message is not a measured first post',async()=>{
  const {browser,calls}=browserFixture();
  const result=await runHumanHome({target:'http://fixture.invalid',round:1,launchBrowser:async()=>browser});
  assert.equal(result.firstPost,null);
  assert.ok(result.firstRoom,'room visibility remains inspectable');
  assert.equal(result.status,'not_available');
  assert.equal(pathMetric(result).status,'not_available');
  assert.ok(result.confusions.some(x=>x.includes('does not post')));
  assert.equal(calls.filter(x=>x.includes('/api/account-rooms')).length,2);
});

test('missing first room is not recorded as activation or first post',async()=>{
  const {browser}=browserFixture({roomVisible:false});
  const result=await runHumanHome({target:'http://fixture.invalid',round:2,launchBrowser:async()=>browser});
  assert.equal(result.firstRoom,null);
  assert.equal(result.firstPost,null);
  assert.equal(result.status,'not_available');
});
