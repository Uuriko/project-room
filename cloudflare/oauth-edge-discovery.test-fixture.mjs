import worker from './room.mjs';
export default {
  async fetch(request, env, ctx) {
    let calls=0;
    const mode=new URL(request.url).searchParams.get('fault');
    const fail=async()=>{calls++;if(mode==='hang')await new Promise(resolve=>setTimeout(resolve,1500));throw new Error('synthetic unavailable Room');};
    const room={getByName(){return{fetch:fail};}};
    const response=await worker.fetch(request,{...env,ROOM:room},ctx);
    const headers=new Headers(response.headers);headers.set('X-Test-Room-Calls',String(calls));
    return new Response(response.body,{status:response.status,headers});
  }
};
