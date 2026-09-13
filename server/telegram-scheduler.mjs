// Host-only sequential scheduling. Constructing this object starts no work.
// sync must resolve fresh receive authority on EVERY call (syncReceiving does).
// Stop drains the existing bounded provider request before stores may close.
export function createTelegramScheduler({sync,intervalMs=15000,setTimer=setTimeout,clearTimer=clearTimeout}) {
  if(typeof sync!=='function'||!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>60000
    ||typeof setTimer!=='function'||typeof clearTimer!=='function')throw new Error('telegram_scheduler_invalid');
  let started=false,stopped=false,timer=null,inFlight=null,failures=0,lastResult='idle';
  const schedule=()=>{
    if(stopped)return;
    const delay=Math.min(300000,intervalMs*2**Math.min(failures,9));
    timer=setTimer(()=>{
      timer=null;if(stopped)return;
      inFlight=run();return inFlight;
    },delay);
    timer?.unref?.();
  };
  async function run(){
    try{await Promise.resolve().then(sync);failures=0;lastResult='ok';}
    catch{failures=Math.min(9,failures+1);lastResult='unconfirmed';}
    finally{inFlight=null;schedule();}
  }
  return {
    start(){if(stopped)throw new Error('telegram_scheduler_closed');if(started)return;started=true;schedule();},
    async stop(){stopped=true;if(timer!==null){clearTimer(timer);timer=null;}await inFlight;},
    status(){return {state:stopped?(inFlight?'draining':'stopped'):!started?'idle':inFlight?'running':'waiting',lastResult};}
  };
}
