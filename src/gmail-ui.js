// Gmail-native workspace; provider capabilities stay distinct from room sharing.
export function installGmailWorkspace({ api, ownerKey }) {
  const panel = document.querySelector('#inbox-panel');
  const root = document.createElement('section'); root.className = 'gmail-workspace'; root.hidden = true;
  root.innerHTML = `<header class="gmail-toolbar"><button type="button" data-back>← All messages</button><strong data-address></strong><button type="button" data-compose>New email</button></header>
    <p data-notice role="status"></p><form class="gmail-toolbar" data-search><label>Folder <select name="folder"><option value="inbox">Inbox</option><option value="starred">Starred</option><option value="sent">Sent</option><option value="drafts">Drafts</option><option value="all">All mail</option><option value="trash">Trash</option></select></label><label>Search Gmail <input name="query" type="search" maxlength="500" placeholder="Search email"></label><button>Search</button><button type="button" data-refresh>Refresh</button></form>
    <div class="gmail-columns"><nav aria-label="Gmail messages"><div data-list></div><button type="button" data-more hidden>Older messages</button></nav><article data-reader aria-label="Email"><p>Choose an email to read it.</p></article></div>`;
  panel.append(root);
  const dialog = document.createElement('dialog'); dialog.className = 'gmail-compose'; dialog.setAttribute('aria-labelledby', 'gmail-compose-title');
  dialog.innerHTML = `<form><h2 id="gmail-compose-title">New email</h2><p data-from></p><label>To<input name="to" placeholder="name@example.com" maxlength="4096"></label><details><summary>Cc / Bcc</summary><label>Cc<input name="cc" maxlength="4096"></label><label>Bcc<input name="bcc" maxlength="4096"></label></details><label>Subject<input name="subject" maxlength="4096"></label><label>Message<textarea name="body" rows="12" maxlength="100000"></textarea></label><p class="form-hint">Plain-text email. Attachments can be added in Gmail.</p><p data-result role="status"></p><footer><button type="button" data-save>Save to Gmail drafts</button><button type="submit" data-send>Send email</button><button type="button" data-close>Close</button></footer></form>`;
  document.body.append(dialog);
  for (const b of [...root.querySelectorAll('button'), ...dialog.querySelectorAll('button')]) b.className = 'button ghost';
  dialog.querySelector('[data-send]').className = 'button primary';
  root.querySelector('[data-compose]').className = 'button primary';
  const $ = s => root.querySelector(s), d = s => dialog.querySelector(s), form = dialog.querySelector('form');
  let status = null, generation = 0, listTurn = 0, readTurn = 0, next = null, selected = null, editing = null, pending = null, busy = false, dirty = false;
  const notice = value => { $('[data-notice]').textContent = value; };
  const call = data => api.request('/gmail/mailbox', { method: 'POST', data });
  const fence = () => { const owner = ownerKey(), turn = generation; return () => owner && owner === ownerKey() && turn === generation; };
  const emails = value => (value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi) ?? []);
  const button = (text, fn, parent) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'button ghost'; b.textContent = text; b.addEventListener('click', fn); parent.append(b); return b; };
  function errorText(error) { return ['gmail_reconnect_required', 'gmail_write_permission_required'].includes(error.code) ? 'Reconnect Gmail from All messages to allow sending and organizing email.' : error.code === 'gmail_draft_changed' ? 'This draft changed in Gmail. Close and reopen it before editing.' : error.message || 'Gmail could not complete this request.'; }
  async function list(older = false) {
    const current = fence(), turn = ++listTurn, search = $('[data-search]');
    notice('Loading email…'); $('[data-more]').disabled = true;
    try {
      const result = await call({ action: 'list', folder: search.elements.folder.value, query: search.elements.query.value, pageToken: older ? next : null });
      if (!current() || turn !== listTurn) return;
      if (!older) $('[data-list]').replaceChildren();
      for (const row of result.messages) {
        const b = button('', () => read(row), $('[data-list]')); b.className = 'gmail-message';
        const sender = document.createElement('strong'), subject = document.createElement('span');
        sender.textContent = row.from || '(Draft)'; subject.textContent = row.subject || '(No subject)'; b.append(sender, subject);
        b.classList.toggle('unread', row.labels.includes('UNREAD'));
      }
      next = result.nextPageToken; $('[data-more]').hidden = !next; notice(result.messages.length ? '' : 'No email here.');
    } catch (error) { if (current() && turn === listTurn) notice(errorText(error)); }
    finally { if (current() && turn === listTurn) $('[data-more]').disabled = false; }
  }
  async function read(row) {
    const current = fence(), turn = ++readTurn; notice('Opening email…');
    try {
      const result = await call({ action: 'read', id: row.id, draftId: row.draftId });
      if (!current() || turn !== readTurn) return;
      selected = result.message; const m = selected, reader = $('[data-reader]'); reader.replaceChildren();
      const title = document.createElement('h2'), meta = document.createElement('p'), body = document.createElement('pre'), actions = document.createElement('div'); actions.className = 'gmail-toolbar';
      title.textContent = m.subject || '(No subject)'; meta.textContent = `${m.from} → ${m.to}${m.cc ? ' · Cc: ' + m.cc : ''} · ${m.date}`; body.textContent = m.body || m.snippet;
      reader.append(title, meta, actions, body);
      if (m.attachments.length) { const p = document.createElement('p'); p.textContent = 'Attachments (open in Gmail): ' + m.attachments.map(a => a.name).join(', '); reader.append(p); }
      const link = document.createElement('a'); link.textContent = 'Open in Gmail'; link.href = 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(status.address) + '#all/' + encodeURIComponent(m.id); link.target = '_blank'; link.rel = 'noopener noreferrer'; reader.append(link);
      if (status.canWrite) {
        if (m.draftId) { const b = button('Edit draft', () => compose('draft', m), actions); b.disabled = !m.editable; }
        else if (!m.labels.includes('DRAFT')) {
          button('Reply', () => compose('reply', m), actions); button('Reply all', () => compose('reply-all', m), actions); button('Forward text', () => compose('forward', m), actions);
          for (const [label, action] of [['Archive', 'archive'], [m.labels.includes('UNREAD') ? 'Mark read' : 'Mark unread', m.labels.includes('UNREAD') ? 'read-mark' : 'unread'], [m.labels.includes('STARRED') ? 'Unstar' : 'Star', m.labels.includes('STARRED') ? 'unstar' : 'star'], [m.labels.includes('TRASH') ? 'Restore to mailbox' : 'Move to trash', m.labels.includes('TRASH') ? 'untrash' : 'trash']]) button(label, () => act(action, m, actions), actions);
        }
      }
      notice('');
    } catch (error) { if (current() && turn === readTurn) notice(errorText(error)); }
  }
  async function act(action, message, actions) {
    const current = fence(); for (const b of actions.querySelectorAll('button')) b.disabled = true;
    try {
      const result = await call({ action, id: message.id, requestId: crypto.randomUUID() }); if (!current()) return;
      if (result.state !== 'accepted') { notice('Gmail has not confirmed this change. Refresh or check Gmail before trying again.'); return; }
      await list(); if (current() && selected?.id === message.id) await read(message);
    } catch (error) { if (current()) notice(errorText(error)); }
    finally { if (current()) for (const b of actions.querySelectorAll('button')) b.disabled = false; }
  }
  function compose(mode = 'new', m = null) {
    if (!status?.canWrite || !ownerKey()) return;
    form.reset(); editing = null; pending = null; dirty = false; busy = false; lock(false); d('[data-result]').textContent = ''; d('[data-send]').textContent = 'Send email';
    d('[data-from]').textContent = 'From ' + status.address; d('h2').textContent = mode === 'draft' ? 'Edit draft' : mode.startsWith('reply') ? 'Reply' : mode === 'forward' ? 'Forward text' : 'New email';
    if (m) {
      if (mode === 'draft') { editing = { draftId: m.draftId, expectedMessageId: m.id }; for (const k of ['to', 'cc', 'bcc', 'subject', 'body']) form.elements[k].value = m[k]; }
      else if (mode === 'forward') { form.elements.subject.value = 'Fwd: ' + m.subject; form.elements.body.value = `\n\n---------- Forwarded text ----------\nFrom: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`; }
      else {
        editing = { replyId: m.id }; form.elements.subject.value = /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject;
        const sender = emails(m.replyTo || m.from);
        const recipients = (sender.every(e => e.toLowerCase() === status.address.toLowerCase()) ? emails(m.to) : sender).filter(e => e.toLowerCase() !== status.address.toLowerCase()); form.elements.to.value = recipients.join(', ');
        if (mode === 'reply-all') form.elements.cc.value = [...new Set([...emails(m.to), ...emails(m.cc)])].filter(e => e.toLowerCase() !== status.address.toLowerCase() && !recipients.some(r => r.toLowerCase() === e.toLowerCase())).join(', ');
      }
    }
    dialog.showModal(); form.elements[mode.startsWith('reply') ? 'body' : 'to'].focus();
  }
  function lock(value) { for (const el of form.querySelectorAll('input,textarea,button')) el.disabled = value; }
  async function submit(action) {
    if (busy) return;
    const current = fence(); busy = true; lock(true);
    const data = pending ?? { action, requestId: crypto.randomUUID(), ...editing, ...Object.fromEntries(['to', 'cc', 'bcc', 'subject', 'body'].map(k => [k, form.elements[k].value])) };
    pending = data; d('[data-result]').textContent = action === 'send' ? 'Sending…' : 'Saving…';
    try {
      const result = await call(data); if (!current()) return;
      if (result.state !== 'accepted') { d('[data-result]').textContent = 'Gmail has not confirmed this request. Check Sent or Drafts in Gmail before composing again. This request will not be sent again.'; d('[data-close]').disabled = false; return; }
      pending = null; dirty = false;
      if (data.action === 'send') { dialog.close(); notice('Email sent.'); await list(); }
      else { editing = { ...editing, draftId: result.id, expectedMessageId: result.messageId }; lock(false); d('[data-result]').textContent = 'Saved to Gmail drafts.'; }
    } catch (error) {
      if (!current()) return;
      if (['gmail_invalid_address', 'gmail_invalid_message', 'gmail_invalid_reply', 'gmail_invalid_request', 'gmail_draft_changed', 'gmail_draft_unsupported', 'gmail_write_permission_required', 'gmail_reconnect_required', 'rate_limited'].includes(error.code)) { pending = null; lock(false); d('[data-result]').textContent = errorText(error); }
      else { d('[data-result]').textContent = 'Connection interrupted. Check this same request before editing or sending again.'; d('[data-send]').disabled = false; d('[data-send]').textContent = 'Check request'; d('[data-close]').disabled = false; }
    } finally { if (current()) busy = false; }
  }
  function close() { if (busy) return; if (dirty && !pending && !confirm('Close without saving these changes?')) return; dialog.close(); }
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('submit', e => { e.preventDefault(); submit('send'); });
  d('[data-save]').addEventListener('click', () => submit('save')); d('[data-close]').addEventListener('click', close);
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  $('[data-back]').addEventListener('click', () => { root.hidden = true; panel.classList.remove('gmail-active'); document.querySelector('#inbox-gmail-open').focus(); });
  $('[data-compose]').addEventListener('click', () => compose());
  $('[data-search]').addEventListener('submit', e => { e.preventDefault(); list(); });
  $('[data-search]').elements.folder.addEventListener('change', () => list());
  $('[data-refresh]').addEventListener('click', () => list()); $('[data-more]').addEventListener('click', () => list(true));
  return {
    setStatus(value) { if (status && (status.address !== value.address || value.state !== 'connected')) this.reset(); status = value; $('[data-address]').textContent = value.address ?? ''; $('[data-compose]').disabled = !value.canWrite; },
    open() { if (!ownerKey() || status?.state !== 'connected') return; root.hidden = false; panel.classList.add('gmail-active'); $('[data-compose]').focus(); list(); },
    reset() { generation++; listTurn++; readTurn++; status = selected = editing = pending = null; busy = dirty = false; dialog.close(); form.reset(); d('[data-from]').textContent = ''; d('[data-result]').textContent = ''; root.hidden = true; panel.classList.remove('gmail-active'); $('[data-list]').replaceChildren(); $('[data-reader]').replaceChildren(); $('[data-address]').textContent = ''; notice(''); }
  };
}
