// Human notification preferences and browser subscriptions share one fenced room route.
export async function humanPushRoute(ctx) {
  const roomId = ctx.params.roomId, write = ctx.req.method !== "GET";
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403,"access_denied","Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401,"unauthenticated","Browser session required");
  if (auth.kind === "api-key") {
    const needed = write ? "rooms:write" : "rooms:read";
    if (!(auth.apiKeyScopes ?? []).some(s => s === needed || s === "rooms:*")) ctx.reject(403,"insufficient_scope",`API key lacks ${needed}`);
  }
  ctx.rate(`read:${auth.credentialHash}`,600);
  if (write) { ctx.protectWrite(ctx.req,auth,selected.bearer); ctx.rate(`write:${auth.credentialHash}`,60); }
  const methods = {GET:"status",POST:"save",PATCH:"setPreferences",DELETE:"remove"};
  if (!write && [...ctx.url.searchParams.keys()].some(k => k !== "auth" || ctx.url.searchParams.getAll(k).length !== 1)) ctx.reject(422,"invalid_human_push","No selection on this route");
  const result = write ? ctx.store.humanPush[methods[ctx.req.method]](selected.token,roomId,await ctx.body(ctx.req),fence)
    : ctx.store.humanPush.status(selected.token,roomId,fence);
  return ctx.json(ctx.res,200,result);
}
export const HUMAN_PUSH_ROUTES = Object.freeze(["GET","POST","PATCH","DELETE"].map(method=>Object.freeze({
  id:`human-push-${method.toLowerCase()}`,method,path:"/api/rooms/{roomId}/human-push",auth:"room",capability:null,scope:"room",handler:humanPushRoute,
  schema:{params:{type:"object",required:["roomId"],properties:{roomId:{type:"string"}}},...(method!=="GET"?{body:{type:"object"}}:{}),response:{type:"object"}},events:[]
})));
