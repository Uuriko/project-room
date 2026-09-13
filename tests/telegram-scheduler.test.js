import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelegramScheduler} from '../server/telegram-scheduler.mjs';
function timers(){
  const pending=new Map();let id=0;
  return {pending,setTimer(fn,delay){pending.set(++id,{fn,delay});return id;},clearTimer(id){pending.delete(id);},
    fire(){const [id,t]=pending.entries().next().value;pending.delete(id);return t.fn();}};
}
test('scheduler is opt-in, sequential and stop drains in-flight work without rearming',async()=>{
  const clock=timers();let calls=0,finish;
  const s=createTelegramScheduler({...clock,sync:()=>{calls++;return new Promise(r=>finish=r);}});
  assert.equal(clock.pending.size,0);assert.equal(s.status().state,'idle');
  s.start();s.start();assert.equal(clock.pending.size,1);
  const tick=clock.fire();await Promise.resolve();assert.equal(calls,1);assert.equal(clock.pending.size,0);assert.equal(s.status().state,'running');
  let stopped=false;const stop=s.stop().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false);
  assert.equal(s.status().state,'draining');
  finish();await tick;await stop;assert.equal(clock.pending.size,0);assert.equal(s.status().state,'stopped');
  assert.throws(()=>s.start(),/closed/);await s.stop();
});
test('failures back off to a bounded delay, never expose provider errors, and successful retry resets delay',async()=>{
  const clock=timers();let fail=true,calls=0;
  const s=createTelegramScheduler({...clock,sync(){calls++;if(fail)throw new Error('secret provider URL');}});
  s.start();assert.equal([...clock.pending.values()][0].delay,15000);
  for(let i=0;i<12;i++)await clock.fire();
  assert.equal(calls,12);assert.equal([...clock.pending.values()][0].delay,300000);
  assert.deepEqual(s.status(),{state:'waiting',lastResult:'unconfirmed'});
  fail=false;await clock.fire();assert.equal([...clock.pending.values()][0].delay,15000);
  await s.stop();assert.equal(clock.pending.size,0);
});
test('invalid scheduling budgets are refused before allocating timers',()=>{
  for(const intervalMs of [0,999,60001,Infinity,1.5,'15000'])assert.throws(()=>createTelegramScheduler({sync(){},intervalMs}));
});
