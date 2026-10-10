#!/usr/bin/env node
// HUMAN-100 guild-02 helper: read muse-room events, post charter/rollup.
// Usage:
//   node room-helper.mjs events --after N --limit L   (prints compact event rows)
//   node room-helper.mjs post --file PATH             (posts file contents as one message)
//   node room-helper.mjs post --text "body"
// Reads Jill's room token from ~/.config/jill-room/conn/connection.json (task-authorized use only).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import https from 'node:https';

const HOME = process.env.HOME || '/home/hatch';
const ORIGIN = 'https://room.trydemigod.com';
const ROOM = 'muse-room';

const conn = JSON.parse(readFileSync(`${HOME}/.config/jill-room/conn/connection.json`, 'utf8'));
const TOKEN = conn.token;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'human100-guild02/1.0',
      },
      timeout: 30000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(b);
        else reject(new Error(`${method} ${path} -> ${res.statusCode}: ${b.slice(0, 300)}`));
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
    if (body) r.end(body); else r.end();
  });
}

const verb = process.argv[2];
const args = process.argv.slice(3);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

if (verb === 'events') {
  const after = flag('--after') || '0';
  const limit = flag('--limit') || '100';
  const body = await req('GET', `/api/rooms/${ROOM}/events?after=${after}&limit=${limit}`);
  const page = JSON.parse(body);
  for (const row of page.events || []) {
    const ev = row.event || {};
    const d = ev.data || {};
    let text = '';
    if (ev.type === 'message.posted') text = String(d.body || '').slice(0, 600);
    else text = JSON.stringify(d).slice(0, 300);
    console.log(`seq=${row.sequence} type=${ev.type} author=${d.authorName || d.displayName || d.memberId || ''}\n  ${text.replace(/\n/g, '\n  ')}\n`);
  }
  console.log(`hasMore=${page.hasMore} next=${page.next}`);
} else if (verb === 'post') {
  let text = flag('--text');
  if (!text && flag('--file')) text = readFileSync(flag('--file'), 'utf8');
  if (!text) { console.error('need --text or --file'); process.exit(1); }
  const envelope = JSON.stringify({
    id: randomUUID(),
    type: 'message.posted',
    data: { messageId: randomUUID(), body: text },
  });
  await req('POST', `/api/rooms/${ROOM}/commands`, envelope);
  console.log('posted ok, ' + text.length + ' chars');
} else {
  console.error('usage: events --after N --limit L | post --file PATH | post --text "..."');
  process.exit(1);
}
