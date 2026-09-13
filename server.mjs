import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { RoomStore } from "./server/store.mjs";
import { createRoomServer } from "./server/http.mjs";
import { deploymentConfig } from "./server/deployment.mjs";
import { createServer } from "node:http";
import { maintenanceEnabled, maintenanceReply } from "./server/maintenance.mjs";
import { providerConfig } from './server/provider-config.mjs';
import { assertProductionReady } from './server/production-gates.mjs';
import { openJoinContract } from './server/open-contract.mjs';

const { host, port, origin, filename, production } = deploymentConfig();
const paused = maintenanceEnabled(process.env.ROOM_MAINTENANCE);
const productionGates = paused ? { production: false, providerAuth: null, operatorAccountId: null }
  : assertProductionReady(process.env, origin, { ship: openJoinContract().ship });
const providerAuth = paused ? null : (productionGates.providerAuth || providerConfig(process.env, origin));
process.umask(0o077);
let havePilotDb = false;
try { havePilotDb = statSync(filename).isFile(); }
catch (error) { if (error?.code !== "ENOENT") throw error; }
if (!paused && production && !havePilotDb) throw new Error("Provision a persistent pilot database before startup");
if (!paused) mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
const store = paused ? null : new RoomStore(filename);
let gmailRuntime = null, telegramRuntime = null, twilioRuntime = null, webhookPort = null;
if (store && ['ROOM_GMAIL_CLIENT_FILE', 'ROOM_GMAIL_KEY_FILE', 'ROOM_GMAIL_VAULT_FILE'].some(name => process.env[name])) {
  try {
    const { createGmailRuntime } = await import('./server/gmail-runtime.mjs');
    gmailRuntime = createGmailRuntime({ store, origin });
  } catch (error) { store.close(); throw error; }
}
if (store && ['ROOM_TELEGRAM_REGISTRY_FILE','ROOM_TELEGRAM_QUEUE_FILE','ROOM_TELEGRAM_KEY_FILE','ROOM_TELEGRAM_ACCOUNT_ID','ROOM_TELEGRAM_CONNECTION_ID','ROOM_TELEGRAM_RECEIVE_GRANTS_FILE','ROOM_TELEGRAM_POLL_INTERVAL_MS'].some(name=>process.env[name])) {
  try {
    const { createTelegramRuntime } = await import('./server/telegram-runtime.mjs');
    telegramRuntime = createTelegramRuntime({store});
  } catch (error) { gmailRuntime?.close(); store.close(); throw error; }
}
if (store && ['ROOM_TWILIO_REGISTRY_FILE','ROOM_TWILIO_KEY_FILE','ROOM_TWILIO_ACCOUNT_ID','ROOM_TWILIO_CONNECTION_ID','ROOM_TWILIO_RECEIVE_GRANTS_FILE','ROOM_TWILIO_WEBHOOK_PATH','ROOM_TWILIO_WEBHOOK_PORT'].some(name=>process.env[name])) {
  try {
    const {createTwilioRuntime,twilioWebhookPort}=await import('./server/twilio-runtime.mjs');
    webhookPort=twilioWebhookPort();
    twilioRuntime=createTwilioRuntime({store});
  }catch(error){telegramRuntime?.close();gmailRuntime?.close();store.close();throw error;}
}
if (store && production && !store.db.prepare("SELECT 1 FROM rooms LIMIT 1").get()) { twilioRuntime?.close(); telegramRuntime?.close(); gmailRuntime?.close(); store.close(); throw new Error("Provision a room before deployment"); }
const server = paused ? createServer((req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.origin !== origin || req.headers.host !== new URL(origin).host) {
      res.writeHead(403, { "Cache-Control": "no-store" }); res.end(); return;
    }
    const reply = maintenanceReply(url.pathname);
    res.writeHead(reply.status, reply.headers); res.end(req.method === "HEAD" ? undefined : reply.body);
  } catch { res.writeHead(400, { "Cache-Control": "no-store" }); res.end(); }
}) : createRoomServer({ store, origin, trustedLocalProxy: production, providerAuth, gmailConnections: gmailRuntime?.connections, telegramConnections: telegramRuntime?.connections, twilioConnections: twilioRuntime?.connections, operatorAccountId: productionGates.operatorAccountId });
let closing = false;
function close(exitCode=0) {
  if (closing) return;
  closing = true;
  server.closeStreams?.();
  twilioRuntime?.close();
  const drained=telegramRuntime?.stopReceiving();
  server.close(async () => { await drained;telegramRuntime?.close(); gmailRuntime?.close(); store?.close(); process.exit(exitCode); });
  server.closeIdleConnections();
}
process.on("SIGINT", () => close());
process.on("SIGTERM", () => close());
const listen=(target,p,h)=>new Promise((resolve,reject)=>{
  target.once('error',reject);target.listen(p,h,()=>{target.removeListener('error',reject);resolve();});
});
try{
  if(webhookPort!==null)await listen(twilioRuntime.webhook,webhookPort,'127.0.0.1');
  await listen(server,port,host);
  if(!closing)telegramRuntime?.startReceiving();
  console.log(`Project Room ${paused ? "paused" : production ? "invite-only pilot" : "local pilot"}: ${origin}`);
}catch{
  server.closeAllConnections();server.close();twilioRuntime?.close();await telegramRuntime?.stopReceiving();telegramRuntime?.close();gmailRuntime?.close();store?.close();
  throw new Error('Project Room listener startup failed');
}
for(const target of [server,twilioRuntime?.webhook].filter(Boolean))target.on('error',()=>close(1));
