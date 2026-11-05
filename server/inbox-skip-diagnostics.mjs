import {isWorkersRuntime} from './ip-blocklist.mjs';

// Operator diagnostics only. No room/member keys, source values or timestamps.
// Weak keys release closed stores; only fixed counters/configuration survive.
const stores=new WeakMap();
export const INBOX_SKIP_STOP_REASONS=Object.freeze(['addressed','window','budget','parent_unverified','row_bound','error']);
export const INBOX_SKIP_DIAGNOSTIC_PERIOD=64;
const MAX_COUNTER=0xffffffff;
const empty=()=>Object.fromEntries(INBOX_SKIP_STOP_REASONS.map(reason=>[reason,0]));
const operatorEmit=entry=>{if(isWorkersRuntime())console.info(JSON.stringify(entry));};
const stateFor=db=>{
 let state=stores.get(db);
 if(!state){state={enabled:true,emit:operatorEmit,attempts:0,pending:0,stops:empty()};stores.set(db,state);}
 return state;
};
// Server-internal test/operator configuration. Never wired to a reader argument,
// HTTP parameter, room metadata, environment supplied by a caller or MCP tool.
export function configureInboxSkipDiagnostics(db,{enabled=true,emit=operatorEmit}={}){
 if(typeof enabled!=='boolean'||typeof emit!=='function')throw TypeError('Invalid private inbox diagnostics configuration');
 const state=stateFor(db);state.enabled=enabled;state.emit=emit;
}
export function readInboxSkipDiagnostics(db){
 const state=stores.get(db);
 return Object.freeze({attempts:state?.attempts??0,stops:Object.freeze({...state?.stops??empty()})});
}
export function recordInboxSkipStop(db,reason){
 try{
  if(!INBOX_SKIP_STOP_REASONS.includes(reason))return;
  const state=stateFor(db);if(!state.enabled)return;
  state.attempts=Math.min(MAX_COUNTER,state.attempts+1);
  state.stops[reason]=Math.min(MAX_COUNTER,state.stops[reason]+1);
  state.pending++;
  if (state.pending === INBOX_SKIP_DIAGNOSTIC_PERIOD) {
   state.pending=0;
   state.emit(Object.freeze({event:'room.inbox_skip_stops',version:1,...readInboxSkipDiagnostics(db)}));
  }
 }catch{ /* Private observation must never change delivery or its failure. */ }
}
