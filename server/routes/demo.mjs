import { demoRoomView, PUBLIC_PAGE_CSP } from "../public-rooms.mjs";
import { publicPageCsp } from "../../deploy/public-search.mjs";
export function demoRoute(ctx) {
  ctx.rate(`acquisition:${ctx.remoteAddress}`,120);
  const html = demoRoomView({ref:ctx.url.searchParams.get("ref") ?? ""}).html;
  const bytes = Buffer.from(html);
  if (!ctx.url.search) ctx.res.setHeader("X-Robots-Tag","all");
  ctx.res.setHeader("Cache-Control","public, max-age=60");
  ctx.res.setHeader("Link",'<https://room.trydemigod.com/demo>; rel="canonical"');
  ctx.res.setHeader("Content-Security-Policy",publicPageCsp(ctx.expectedOrigin(),PUBLIC_PAGE_CSP));
  ctx.res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Length":bytes.length});
  return ctx.res.end(ctx.req.method === "HEAD" ? undefined : bytes);
}
export const DEMO_ROUTES = Object.freeze(["GET","HEAD"].map(method=>Object.freeze({
 id:`demo-${method.toLowerCase()}`,method,path:"/demo",auth:"none",capability:null,scope:"public",handler:demoRoute,
 schema:{response:{type:"string"}},events:[]
})));
