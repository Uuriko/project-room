// Stateful provider double; never contacts Google or sends real email.
export function gmailLiveFixture() {
  let sequence = 10;
  const messages = new Map(), drafts = new Map(), calls = [];
  const make = (id, headers, body, labels = ['INBOX', 'UNREAD']) => ({ id, threadId: 'thread-1', labelIds: labels, snippet: body, payload: { mimeType: 'text/plain', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { data: Buffer.from(body).toString('base64url') } } });
  messages.set('mail-1', make('mail-1', { From: 'Taylor <taylor@example.com>', To: 'morgan@gmail.test', Subject: 'Friday plan', 'Message-ID': '<original@example.com>', 'Reply-To': 'reply@example.com' }, 'Meet at noon.'));
  function decode(raw, labels) {
    const [head, ...body] = Buffer.from(raw, 'base64url').toString().split('\r\n\r\n'), headers = {};
    for (const line of head.split('\r\n')) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1).trim(); }
    headers.Subject = headers.Subject?.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, data) => Buffer.from(data, 'base64').toString()) ?? '';
    return make('mail-' + ++sequence, headers, Buffer.from(body.join('\r\n\r\n'), 'base64').toString(), labels);
  }
  const config = { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret', tokenKey: '42'.repeat(32), redirectUri: 'https://room.example/api/auth/gmail/callback', fetchImpl: async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url.includes('/token')) return Response.json({ access_token: 'access', refresh_token: 'refresh', scope: 'https://www.googleapis.com/auth/gmail.modify' });
    const u = new URL(url), path = u.pathname.replace('/gmail/v1/users/me', ''), data = init.body ? JSON.parse(init.body) : null;
    if (path === '/profile') return Response.json({ emailAddress: 'morgan@gmail.test' });
    if (path === '/messages/send' || path === '/drafts/send') {
      const message = decode(data.raw ?? data.message.raw, ['SENT']); messages.set(message.id, message);
      if (data.id) drafts.delete(data.id); return Response.json(message);
    }
    if (path === '/drafts' && init.method === 'POST' || path.startsWith('/drafts/') && init.method === 'PUT') {
      const id = data.id ?? 'draft-' + ++sequence, message = decode(data.message.raw, ['DRAFT']); drafts.set(id, { id, message }); return Response.json({ id, message });
    }
    if (path === '/drafts') return Response.json({ drafts: [...drafts.values()].map(({ id, message }) => ({ id, message: { id: message.id } })) });
    if (path.startsWith('/drafts/')) return Response.json(drafts.get(path.split('/')[2]) ?? {}, { status: drafts.has(path.split('/')[2]) ? 200 : 404 });
    if (path === '/messages') {
      const label = u.searchParams.get('labelIds'), query = u.searchParams.get('q');
      return Response.json({ messages: [...messages.values()].filter(m => (!label || m.labelIds.includes(label)) && (!query || m.payload.headers.some(h => h.value.includes(query)))).map(m => ({ id: m.id })) });
    }
    const [, , id, action] = path.split('/'), message = messages.get(id);
    if (!message) return Response.json({}, { status: 404 });
    if (action === 'modify') message.labelIds = [...new Set([...message.labelIds.filter(l => !data.removeLabelIds.includes(l)), ...data.addLabelIds])];
    if (action === 'trash') message.labelIds = ['TRASH'];
    if (action === 'untrash') message.labelIds = [];
    return Response.json(message);
  } };
  return { config, calls, messages, drafts };
}
