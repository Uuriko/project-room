// Actual HTTP causal reproducer on3f1: adding one legal agent to9 tiny native
// tasks exceeds the shared overview input budget. No limits are bypassed.
import {RoomStore} from '../../server/store.mjs';
import {initialRoom} from '../../server/bootstrap.mjs';
import {event} from '../../src/events.js';
import {createRoomServer} from '../../server/http.mjs';
import {RoomClient} from '../../src/client.js';
const store=new RoomStore(':memory:'),events=initialRoom();
events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'joined-agent',displayName:'Joined agent',kind:'agent',permissions:[]}}));
for(let i=0;i<9;i++)events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:`task-${i}`,title:`Task ${i}`,definitionOfDone:`Exact definition ${i}`,accountableMemberId:'owner'}}));
store.initialize(events,{representation:'normalized-current-v1'});
const created=store.createSession(store.issueAccessKey('commons','owner')),server=createRoomServer({store});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,client=new RoomClient({fetcher:(path,options)=>fetch(origin+path,{...options,headers:{...options.headers,Cookie:'room_session='+created.token}})});
client.session={...created.session,authMode:'room',csrf:null};
try{await client.refresh();console.log('OVERVIEW_INPUT_OK');}
catch(error){console.log(JSON.stringify({status:error.status,code:error.code,message:error.message}));process.exitCode=1;}
finally{client.disconnect();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
