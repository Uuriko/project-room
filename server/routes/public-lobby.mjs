import {PUBLIC_PAGE_CSP} from '../public-rooms.mjs';
import {publicPageCsp} from '../public-search.mjs';

import {PUBLIC_LOBBY_ROOM_ID} from '../current-public-face.mjs';
export {PUBLIC_LOBBY_ROOM_ID};
export function publicLobbyRoute(ctx){
 const {store,res}=ctx;
 ctx.rate(`public-face:${ctx.remoteAddress}`,120);
 const lobby=store.db.prepare('SELECT s.public_code FROM room_public_settings s JOIN public_rooms p ON p.slug=s.room_id WHERE p.slug=? AND s.enabled=1').get(PUBLIC_LOBBY_ROOM_ID);
 let status=200,html;
 try{html=lobby
  ?store.publicFace.faceHtml(lobby.public_code,{joinHref:'/docs/agents/paste?room='+encodeURIComponent(PUBLIC_LOBBY_ROOM_ID),lobbyHref:'/r/'+encodeURIComponent(PUBLIC_LOBBY_ROOM_ID)+'#open-tasks',paginate:true,before:ctx.url.searchParams.get('before')})
  :'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="help" type="text/plain" href="/llms.txt" title="Agent instructions"><title>Project Room lobby</title><body><main><h1>No public lobby is published yet</h1><p><a href="/watch">Refresh</a> or <a href="/docs/agents/paste">connect an agent</a>.</p></main></body></html>';}
 catch(error){
  if(error?.code!=='invalid_feed_cursor'||!ctx.url.searchParams.has('before'))throw error;
  // Do not distinguish a deleted, private or unknown cursor.
  status=422;html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="help" type="text/plain" href="/llms.txt" title="Agent instructions"><title>Public history unavailable</title><body><main><h1>This page is no longer available</h1><p><a href="/watch">Return to latest messages</a></p></main></body></html>';
 }
 res.setHeader('Content-Security-Policy',publicPageCsp(ctx.expectedOrigin(),PUBLIC_PAGE_CSP));
 res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(html)});
 return res.end(html);
}
export const PUBLIC_LOBBY_ROUTES=Object.freeze([Object.freeze({
 id:'public-lobby',method:'GET',path:'/watch',auth:'none',capability:null,scope:'public',handler:publicLobbyRoute,
 publication:'open:explicit owner-published official lobby; bounded live General messages only; no private-room discovery',
 parity:'exempt:public read-only HTML viewer; agents connect through the existing MCP and HTTP tools',
 schema:{response:{type:'string'}},events:[]
})]);
