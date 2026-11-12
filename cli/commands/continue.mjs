import {connection} from './code.mjs';
import {RoomAgentClient} from '../../client/room-agent.mjs';
import {createWorkBrief} from '../../client/work-brief.mjs';
import {createWorkContinuation,workContinuationMarkdown} from '../../src/work-continuation.js';
import {validId} from '../../src/events.js';
export async function continueCommand(argv,io={}){
 const out=io.out??console.log;
 if(!argv.length||['--help','-h','help'].includes(argv[0])){out('room continue <work-id> [--markdown]\nRead one current task using the saved connection. Default JSON; optional generated Markdown. No writes, claims or acknowledgements.');return 0;}
 if(!validId(argv[0])||argv.length>2||(argv.length===2&&argv[1]!=='--markdown'))throw Error('Use room continue <work-id> [--markdown]');
 const conn=await(io.connection??connection)({env:io.env??process.env,cwd:io.cwd??process.cwd()});
 const client=new RoomAgentClient({origin:conn.origin,roomId:conn.roomId,token:conn.secret,fetchImpl:io.fetchImpl??fetch});
 const context=await client.workContext(argv[0],{includeSource:false,signal:AbortSignal.timeout(30000)});
 const continuation=createWorkContinuation(await createWorkBrief(context));
 const output=argv[1]==='--markdown'?workContinuationMarkdown(continuation):JSON.stringify(continuation);
 if(typeof conn.secret==='string'&&conn.secret&&output.includes(conn.secret))throw Error('Continuation contains the connection credential; no output emitted');
 out(output);return 0;
}
