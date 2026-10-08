import { WORK_FIT_ACTION_FIELDS } from '../../src/work-fit-contract.js';
const id={type:'string',minLength:1,maxLength:128};
export async function workFitRoute(ctx){
 const roomId=ctx.params.roomId,selected=ctx.roomCredentials(ctx.req,ctx.url);
 const fence=selected.mode==='account'?ctx.accountBinding(ctx.req):ctx.expectedBinding(ctx.req),write=ctx.req.method==='POST';
 const authorize=()=>{
  const auth=ctx.roomAuth(selected,roomId,fence);
  if(selected.bearer && auth.credentialScope!=='room')ctx.reject(403,'access_denied','Bearer account sessions are not accepted');
  if(!selected.bearer && auth.kind!=='session')ctx.reject(401,'unauthenticated','Browser session required');
  if(auth.kind==='api-key'){
   const needed=write?'rooms:write':'rooms:read';
   if(!(auth.apiKeyScopes??[]).some(s=>s===needed || s.endsWith(':*') && needed.startsWith(s.slice(0,-1))))ctx.reject(403,'insufficient_scope',`API key lacks ${needed}`);
  }
  if(write)ctx.protectWrite(ctx.req,auth,selected.bearer);
  return auth;
 };
 const auth=authorize();ctx.rate(`read:${auth.credentialHash}`,600);if(write)ctx.rate(`write:${auth.credentialHash}`,60);
 let value;
 if(write)value=ctx.store.workFit.apply(roomId,await ctx.body(ctx.req),authorize);
 else{
  const query={};
  for(const [k,v] of ctx.url.searchParams){
   if(['auth','binding'].includes(k))continue;
   if(!['memberId','detail','cursor','workItemId','categories','role'].includes(k) || Object.hasOwn(query,k))ctx.reject(422,'invalid_work_fit','Invalid profile query');
   query[k]=k==='categories'?v.split(','):v;
  }
  value=ctx.store.workFit.read(roomId,query,authorize);
 }
 return ctx.json(ctx.res,200,value,ctx.req.method==='HEAD');
}
const properties=Object.fromEntries([...new Set(Object.values(WORK_FIT_ACTION_FIELDS).flat())].map(k=>[k,{}]));
export const WORK_FIT_ROUTES=Object.freeze(['GET','HEAD','POST'].map(method=>Object.freeze({id:`work-fit-${method.toLowerCase()}`,method,path:'/api/rooms/{roomId}/work-fit',auth:'room',capability:null,scope:'room',handler:workFitRoute,schema:{params:{type:'object',required:['roomId'],properties:{roomId:id}},...(method==='POST'?{body:{type:'object',required:['action','requestId'],additionalProperties:false,properties:{action:{type:'string',enum:Object.keys(WORK_FIT_ACTION_FIELDS)},requestId:id,...properties}}}:{}),response:{type:'object'}},events:[]})));
