import { parseStructuredHeader, splitMultipart, decodeEncodedWords } from '../server/mime-message.mjs';
// Stateful provider double; never contacts Google or sends real email.
export function gmailLiveFixture(address = 'morgan@gmail.test') {
  let sequence = 10, historyId = 1000; const history = [];
  const messages = new Map(), drafts = new Map(), calls = [];
  const make = (id, headers, body, labels = ['INBOX', 'UNREAD']) => ({ id, historyId: String(historyId), internalDate: '1700000000000', threadId: 'thread-1', labelIds: labels, snippet: body, payload: { mimeType: 'text/plain', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { data: Buffer.from(body).toString('base64url') } } });
  messages.set('mail-1', make('mail-1', { From: 'Taylor <taylor@example.com>', To: 'morgan@gmail.test', Subject: 'Friday plan', 'Message-ID': '<original@example.com>', 'Reply-To': 'reply@example.com' }, 'Meet at noon.'));
  const changed = message => { message.historyId = String(++historyId); history.push({ id: String(historyId), messages: [{ id: message.id }] }); };
  function payload(raw) {
    const [head, ...tail] = raw.split('\r\n\r\n'), headers = {};
    for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).toLowerCase()] = decodeEncodedWords(line.slice(i + 1).trim()); }
    const type = parseStructuredHeader(headers['content-type'] ?? 'text/plain'), disposition = parseStructuredHeader(headers['content-disposition']);
    const body = tail.join('\r\n\r\n');
    return { mimeType: type.type, filename: disposition.parameters.filename ?? '', headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      ...(type.type.startsWith('multipart/') ? { parts: splitMultipart(body, type.parameters.boundary).map(payload), body: {} } : { body: { data: Buffer.from(body, headers['content-transfer-encoding'] === 'base64' ? 'base64' : 'utf8').toString('base64url'), size: Buffer.from(body, headers['content-transfer-encoding'] === 'base64' ? 'base64' : 'utf8').length } }) };
  }
  function decode(raw, labels) {
    const message = make('mail-' + ++sequence, {}, '', labels); message.payload = payload(Buffer.from(raw, 'base64url').toString()); changed(message); return message;
  }
  const config = { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret', tokenKey: '42'.repeat(32), redirectUri: 'https://room.example/api/auth/gmail/callback', fetchImpl: async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url.includes('/token')) return Response.json({ access_token: 'access-' + address, refresh_token: 'refresh-' + address, scope: 'https://www.googleapis.com/auth/gmail.modify' });
    const u = new URL(url), path = u.pathname.replace('/gmail/v1/users/me', ''), data = init.body ? JSON.parse(init.body) : null;
    if (path === '/history') return Response.json({ history: history.filter(h => Number(h.id) > Number(u.searchParams.get('startHistoryId'))), historyId: String(historyId) });
    if (path.startsWith('/threads/')) return Response.json({ id: path.split('/')[2], messages: [...messages.values()].filter(m => m.threadId === path.split('/')[2]) });
    if (path === '/profile') return Response.json({ emailAddress: address, historyId: String(historyId) });
    if (path === '/messages/send' || path === '/drafts/send') {
      const message = decode(data.raw ?? data.message.raw, ['SENT']); messages.set(message.id, message);
      if (data.id) { const prior = drafts.get(data.id); if (prior) messages.delete(prior.message.id); drafts.delete(data.id); } return Response.json(message);
    }
    if (path === '/drafts' && init.method === 'POST' || path.startsWith('/drafts/') && init.method === 'PUT') {
      const id = data.id ?? 'draft-' + ++sequence, message = decode(data.message.raw, ['DRAFT']); if (drafts.has(id)) messages.delete(drafts.get(id).message.id); drafts.set(id, { id, message }); messages.set(message.id, message); return Response.json({ id, message });
    }
    if (path.startsWith('/drafts/') && init.method === 'DELETE') { const prior = drafts.get(path.split('/')[2]); if (prior) messages.delete(prior.message.id); drafts.delete(path.split('/')[2]); return new Response(null, { status: 204 }); }
    if (path === '/drafts') return Response.json({ drafts: [...drafts.values()].map(({ id, message }) => ({ id, message: { id: message.id } })) });
    if (path.startsWith('/drafts/')) return Response.json(drafts.get(path.split('/')[2]) ?? {}, { status: drafts.has(path.split('/')[2]) ? 200 : 404 });
    if (path === '/messages') {
      const label = u.searchParams.get('labelIds'), query = u.searchParams.get('q');
      return Response.json({ messages: [...messages.values()].filter(m => (!label || m.labelIds.includes(label)) && (!query || m.payload.headers.some(h => h.value.includes(query.includes('rfc822msgid:') ? query.split('rfc822msgid:')[1] : query)))).map(m => ({ id: m.id })) });
    }
    const [, , id, action] = path.split('/'), message = messages.get(id);
    if (!message) return Response.json({}, { status: 404 });
    if (action === 'modify') message.labelIds = [...new Set([...message.labelIds.filter(l => !data.removeLabelIds.includes(l)), ...data.addLabelIds])];
    if (action === 'trash') message.labelIds = ['TRASH'];
    if (action === 'untrash') message.labelIds = [];
    if (action) changed(message);
    return Response.json(message);
  } };
  return { config, calls, messages, drafts, changed, history };
}
