import { createServer } from 'node:http';
import { importTwilioMessage } from './twilio-inbox-import.mjs';

// Dedicated host factory, NOT enabled by server.mjs. TLS/host validation belongs
// to the deployment proxy. Signatures use the registry URL, never request Host.
// Route bindings and account sessions are trusted host configuration, not body
// fields. A current session is required: no implicit background authority.
export function createTwilioWebhookServer({store, routes, now=Date.now, limit=60}) {
  if(!Array.isArray(routes) || !routes.length || routes.length>100 || !Number.isInteger(limit) || limit<1 || limit>600)
    throw new Error('invalid_twilio_webhook_config');
  const bindings=new Map();
  for(const route of routes) {
    if(!/^\/webhooks\/twilio\/[A-Za-z0-9_-]{1,128}$/.test(route.path) || bindings.has(route.path)
      || typeof route.withConnection!=='function' || typeof route.getSession!=='function') throw new Error('invalid_twilio_webhook_config');
    bindings.set(route.path,{...route,window:0,count:0});
  }
  const server=createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:10000},(req,res)=>{
    let finished=false,bytes=0;const chunks=[];
    const finish=(status,body='')=>{
      if(finished)return;finished=true;clearTimeout(timer);
      res.writeHead(status,{'Content-Type':status===200?'application/xml; charset=utf-8':'text/plain; charset=utf-8',
        'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close',...(status===429?{'Retry-After':'60'}:{})});
      res.end(body);
    };
    const timer=setTimeout(()=>{finish(408);req.resume();},5000);timer.unref();
    req.on('error',()=>finish(400));res.on('close',()=>{finished=true;clearTimeout(timer);});
    const route=bindings.get(req.url);
    if(!route){finish(404);req.resume();return;}
    if(req.method!=='POST'){finish(405);req.resume();return;}
    const time=now();if(!Number.isSafeInteger(time)||time<0){finish(503);req.resume();return;}
    const window=Math.floor(time/60000);if(route.window!==window){route.window=window;route.count=0;}
    if(++route.count>limit){finish(429);req.resume();return;}
    if(req.headers['content-type']?.split(';')[0].trim()!=='application/x-www-form-urlencoded'
      || typeof req.headers['x-twilio-signature']!=='string' || req.headers['x-twilio-signature'].length>128
      || req.headers['content-encoding']){finish(400);req.resume();return;}
    req.on('data',chunk=>{if(finished)return;bytes+=chunk.length;if(bytes>65536){finish(413);return;}chunks.push(chunk);});
    req.on('end',()=>{
      if(finished)return;
      try {
        const rawBody=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
        const {slot,session}=route.getSession();
        const receipt=importTwilioMessage({store,slot,session,withConnection:route.withConnection,
          request:{rawBody,contentType:req.headers['content-type'],signature:req.headers['x-twilio-signature']}});
        if(!receipt || ![0,1].includes(receipt.imported) || receipt.duplicate!==(receipt.imported===0))throw new Error();
        // Empty TwiML deliberately performs no reply or other outbound action.
        finish(200,'<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      }catch {finish(503,'Message not confirmed.');}
    });
  });
  server.maxConnections=64;server.maxRequestsPerSocket=1;return server;
}
