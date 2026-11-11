// Synthetic routing-only benchmark: five runs, 40ms injected per selected read.
// No network, listener, agent process or production request is created.
import { Bridge } from "../room-acp/src/bridge.mjs";
const results=[];
for(let run=0;run<5;run++){
 const bridge=new Bridge({connection:{apiBase:"https://room.invalid",roomId:"commons",memberId:"agent",hostId:"bench"},host:{},persistSessions:false});
 const reads=[];const queued=[];
 bridge.readThread=async id=>{reads.push(id);await new Promise(resolve=>setTimeout(resolve,40));return {thread:{id,authorId:"owner",body:"review",replyToId:id==="reply"?"root":null}};};
 bridge.queue={push:(...args)=>{queued.push(args);return true;}};
 const start=performance.now();await bridge.accept({signalId:"signal",messageId:"reply",kind:"reply"});
 results.push({run:run+1,ms:performance.now()-start,reads,queuedRoot:queued[0][0]});bridge.stop();
}
console.log(JSON.stringify({injectedReadLatencyMs:40,runs:results,medianMs:[...results].sort((a,b)=>a.ms-b.ms)[2].ms},null,2));
