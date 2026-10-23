// Fictional loopback data only; actual macOS WKWebView reload acceptance.
import { createResultsFixture } from './results-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { textVersion } from '../server/text-results.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const f = createResultsFixture();
f.send('owner','room.history_visibility_set',{historyVisibility:'all'});
const server = createRoomServer({store:f.store,streamInterval:50});
const handler = server.listeners('request')[0];
server.removeListener('request',handler);
let advanced = false;
server.on('request',(req,res) => {
  if (req.url !== '/native-acceptance-advance') return handler(req,res);
  if (req.method !== 'POST' || advanced) { res.writeHead(409); return res.end(); }
  try {
    const previous = f.state().workItems['native-result'].receipt.eventId;
    f.reopen('native-result');
    f.change('native-result','work.blocker_resolved',{resolution:'Native recovery qualification'});
    const body='Replacement version: this must not replace the pinned original.';
    const posted=f.send('producer','message.posted',{messageId:'native-newer-result',workItemId:'native-result',body});
    f.change('native-result','work.completed',{summary:'Newer result',nextAction:'Review',producerId:'producer',evidenceKind:'room_text',previousCompletionEventId:previous,evidenceMessageId:'native-newer-result',evidenceMessageEventId:posted.event.id,evidenceVersion:textVersion(body)});
    advanced=true;res.writeHead(200);res.end('{}');
  } catch(error) { res.writeHead(500);res.end(JSON.stringify({error:error.message})); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const out=resolve(process.argv[2] || 'test-results/native-result-recovery');mkdirSync(out,{recursive:true});
try {
  const child=spawn('desktop/macos/.build/release/RoomAcceptance',[
    `http://127.0.0.1:${server.address().port}/#join/${f.links.valid}`,
    'desktop/macos/acceptance/result-recovery.js.txt','--after-reload','desktop/macos/acceptance/result-recovery-after.js.txt','--screenshot',`${out}/native-result-recovery.png`
  ],{stdio:'inherit'});
  const timeout=setTimeout(()=>child.kill('SIGTERM'),90000);
  const code=await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timeout);
  if(code!==0 || !advanced) throw new Error(`Native acceptance failed (${code})`);
} finally {
 server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});
}
