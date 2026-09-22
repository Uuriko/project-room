// Gmail-native workspace; provider capabilities stay distinct from room sharing.
export function installGmailWorkspace({ api, ownerKey, onConnectionsChanged = () => {} }) {
  const panel = document.querySelector('#inbox-panel');
  const root = document.createElement('section'); root.className = 'gmail-workspace'; root.hidden = true;
  root.innerHTML = `<header class="gmail-toolbar"><button type="button" data-back>← All messages</button><label>Gmail account<select data-mailbox aria-label="Gmail account"></select></label><strong data-address></strong><button type="button" data-compose>New email</button></header>
    <details><summary>Manage Gmail accounts</summary><div class="gmail-toolbar"><button type="button" data-add>Add Gmail account</button><button type="button" data-reconnect>Reconnect this account</button><button type="button" data-disconnect>Disconnect this account</button></div></details><p data-notice role="status"></p><form class="gmail-toolbar" data-search><label>Folder <select name="folder"><option value="inbox">Inbox</option><option value="starred">Starred</option><option value="sent">Sent</option><option value="drafts">Drafts</option><option value="all">All mail</option><option value="trash">Trash</option></select></label><label>Search Gmail <input name="query" type="search" maxlength="500" placeholder="Search email"></label><button>Search</button><button type="button" data-refresh>Refresh</button></form>
    <div class="gmail-columns"><nav aria-label="Gmail messages"><div data-list></div><button type="button" data-more hidden>Older messages</button></nav><article data-reader aria-label="Email"><p>Choose an email to read it.</p></article></div>`;
  panel.append(root);
  const dialog = document.createElement('dialog'); dialog.className = 'gmail-compose'; dialog.setAttribute('aria-labelledby', 'gmail-compose-title');
  dialog.innerHTML = `<form><h2 id="gmail-compose-title">New email</h2><p data-from></p><label>To<input name="to" placeholder="name@example.com" maxlength="4096"></label><details><summary>Cc / Bcc</summary><label>Cc<input name="cc" maxlength="4096"></label><label>Bcc<input name="bcc" maxlength="4096"></label></details><label>Subject<input name="subject" maxlength="4096"></label><button type="button" data-format>Formatting</button><div data-format-tools hidden class="gmail-toolbar"><button type="button" data-format-command="bold">Bold</button><button type="button" data-format-command="italic">Italic</button><button type="button" data-format-command="underline">Underline</button><button type="button" data-format-command="insertUnorderedList">List</button><button type="button" data-format-command="createLink">Link</button></div><div data-rich hidden contenteditable="true" role="textbox" aria-label="Formatted message" aria-multiline="true"></div><label data-plain>Message<textarea name="body" rows="12" maxlength="100000"></textarea></label><label>Attach files<input data-files type="file" multiple></label><p class="form-hint">Up to 20 attachments, 10 MiB total.</p><ul data-files-list></ul><p data-result role="status"></p><footer><button type="button" data-save>Save to Gmail drafts</button><button type="submit" data-send>Send email</button><button type="button" data-close>Close</button></footer></form>`;
  document.body.append(dialog);
  for (const b of [...root.querySelectorAll('button'), ...dialog.querySelectorAll('button')]) b.className = 'button ghost';
  dialog.querySelector('[data-send]').className = 'button primary';
  root.querySelector('[data-compose]').className = 'button primary';
  const $ = s => root.querySelector(s), d = s => dialog.querySelector(s), form = dialog.querySelector('form');
  let allMailboxes = [], files = [], richMode = false, status = null, generation = 0, listTurn = 0, readTurn = 0, next = null, selected = null, editing = null, pending = null, busy = false, dirty = false;
  const notice = value => { $('[data-notice]').textContent = value; };
  const call = data => api.request('/gmail/mailbox', { method: 'POST', data: { mailboxId: status?.id, ...data } });
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
      if (m.html) { body.className = 'gmail-html'; body.innerHTML = m.html; }
      reader.append(title, meta, actions, body);
      if (m.attachments.length) { const p = document.createElement('div'); p.className = 'gmail-toolbar'; for (const a of m.attachments) button('Download ' + a.name, () => download(m.id, a.partId), p); reader.append(p); }
      const link = document.createElement('a'); link.textContent = 'Open in Gmail'; link.href = 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(status.address) + '#all/' + encodeURIComponent(m.id); link.target = '_blank'; link.rel = 'noopener noreferrer'; reader.append(link);
      if (status.canWrite) {
        if (m.draftId) { const b = button('Edit draft', () => compose('draft', m), actions); b.disabled = !m.editable; button('Delete draft', () => removeDraft(m), actions); }
        else if (!m.labels.includes('DRAFT')) {
          button('Reply', () => compose('reply', m), actions); button('Reply all', () => compose('reply-all', m), actions); button('Forward', () => compose('forward', m), actions);
          for (const [label, action] of [['Archive', 'archive'], [m.labels.includes('UNREAD') ? 'Mark read' : 'Mark unread', m.labels.includes('UNREAD') ? 'read-mark' : 'unread'], [m.labels.includes('STARRED') ? 'Unstar' : 'Star', m.labels.includes('STARRED') ? 'unstar' : 'star'], [m.labels.includes('TRASH') ? 'Restore to mailbox' : 'Move to trash', m.labels.includes('TRASH') ? 'untrash' : 'trash']]) button(label, () => act(action, m, actions), actions);
        }
      }
      if (m.threadId && !m.draftId) button('Show conversation', () => conversation(m.threadId), actions);
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
    form.reset(); files = []; richMode = false; setRich(false); renderFiles(); editing = null; pending = null; dirty = false; busy = false; lock(false); d('[data-result]').textContent = ''; d('[data-send]').textContent = 'Send email';
    d('[data-from]').textContent = 'From ' + status.address; d('h2').textContent = mode === 'draft' ? 'Edit draft' : mode.startsWith('reply') ? 'Reply' : mode === 'forward' ? 'Forward' : 'New email';
    if (m) {
      if (mode === 'draft') { editing = { draftId: m.draftId, expectedMessageId: m.id }; for (const k of ['to', 'cc', 'bcc', 'subject', 'body']) form.elements[k].value = m[k]; if (m.html) setRich(true, m.html); }
      else if (mode === 'forward') { form.elements.subject.value = 'Fwd: ' + m.subject; form.elements.body.value = `\n\n---------- Forwarded text ----------\nFrom: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`; }
      else {
        editing = { replyId: m.id }; form.elements.subject.value = /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject;
        const sender = emails(m.replyTo || m.from);
        const recipients = (sender.every(e => e.toLowerCase() === status.address.toLowerCase()) ? emails(m.to) : sender).filter(e => e.toLowerCase() !== status.address.toLowerCase()); form.elements.to.value = recipients.join(', ');
        if (mode === 'reply-all') form.elements.cc.value = [...new Set([...emails(m.to), ...emails(m.cc)])].filter(e => e.toLowerCase() !== status.address.toLowerCase() && !recipients.some(r => r.toLowerCase() === e.toLowerCase())).join(', ');
      }
    }
    if (m && ['draft', 'forward'].includes(mode)) { files = m.attachments.map(a => ({ name: a.name, size: a.size, messageId: m.id, partId: a.partId })); renderFiles(); }
    dialog.showModal(); form.elements[mode.startsWith('reply') ? 'body' : 'to'].focus();
  }
  function lock(value) { for (const el of form.querySelectorAll('input,textarea,button')) el.disabled = value; d('[data-rich]').contentEditable = String(!value); }
  async function submit(action) {
    if (busy) return;
    const current = fence(); busy = true; lock(true);
    if (richMode && !pending) form.elements.body.value = d('[data-rich]').innerText;
    const data = pending ?? { action, mailboxId: status.id, html: richMode ? d('[data-rich]').innerHTML : '', attachments: files.map(({ name, size: _size, ...f }) => f.messageId ? f : { name, ...f }), requestId: crypto.randomUUID(), ...editing, ...Object.fromEntries(['to', 'cc', 'bcc', 'subject', 'body'].map(k => [k, form.elements[k].value])) };
    pending = data; d('[data-result]').textContent = action === 'send' ? 'Sending…' : 'Saving…';
    try {
      const result = await call(data); if (!current()) return;
      if (result.state !== 'accepted') { d('[data-result]').textContent = 'Gmail has not confirmed this request. Check Sent or Drafts in Gmail before composing again. This request will not be sent again.'; d('[data-close]').disabled = false; d('[data-send]').disabled = false; d('[data-send]').textContent = 'Check request'; return; }
      pending = null; dirty = false;
      if (data.action === 'send') { dialog.close(); notice('Email sent.'); await list(); }
      else { editing = { ...editing, draftId: result.id, expectedMessageId: result.messageId }; files = files.map((f, i) => ({ name: f.name, size: f.size, messageId: result.messageId, partId: '0.' + (i + 1) })); renderFiles(); lock(false); d('[data-result]').textContent = 'Saved to Gmail drafts.'; }
    } catch (error) {
      if (!current()) return;
      if (['gmail_attachment_review_required', 'gmail_invalid_attachment', 'gmail_attachment_too_large', 'gmail_invalid_address', 'gmail_invalid_message', 'gmail_invalid_reply', 'gmail_invalid_request', 'gmail_draft_changed', 'gmail_draft_unsupported', 'gmail_write_permission_required', 'gmail_reconnect_required', 'rate_limited'].includes(error.code)) { pending = null; lock(false); d('[data-result]').textContent = errorText(error); }
      else { d('[data-result]').textContent = 'Connection interrupted. Check this same request before editing or sending again.'; d('[data-send]').disabled = false; d('[data-send]').textContent = 'Check request'; d('[data-close]').disabled = false; }
    } finally { if (current()) busy = false; }
  }
  function setRich(enabled, html = null) {
    richMode = enabled; d('[data-rich]').hidden = !enabled; d('[data-format-tools]').hidden = !enabled; d('[data-plain]').hidden = enabled;
    if (enabled) { if (html !== null) d('[data-rich]').innerHTML = html; else d('[data-rich]').textContent = form.elements.body.value; }
    else { if (d('[data-rich]').textContent) form.elements.body.value = d('[data-rich]').innerText; d('[data-rich]').replaceChildren(); }
    d('[data-format]').textContent = enabled ? 'Use plain text' : 'Formatting';
  }
  function renderFiles() {
    d('[data-files-list]').replaceChildren();
    files.forEach((file, i) => { const li = document.createElement('li'); li.append(document.createTextNode(file.name + ' ')); button('Remove', () => { files.splice(i, 1); dirty = true; renderFiles(); }, li); d('[data-files-list]').append(li); });
  }
  d('[data-format]').addEventListener('click', () => { setRich(!richMode); dirty = true; });
  for (const b of dialog.querySelectorAll('[data-format-command]')) {
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      const command = b.dataset.formatCommand; let value = null;
      if (command === 'createLink') { value = prompt('Link URL (https://…)'); if (!value || !/^https?:\/\//i.test(value)) return; }
      d('[data-rich]').focus(); document.execCommand(command, false, value); dirty = true;
    });
  }
  d('[data-rich]').addEventListener('paste', e => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
  d('[data-rich]').addEventListener('drop', e => e.preventDefault());
  d('[data-files]').addEventListener('change', async e => {
    const current = fence(), selectedFiles = [...e.target.files]; e.target.value = ''; lock(true); busy = true;
    try {
      if (files.length + selectedFiles.length > 20 || [...files, ...selectedFiles].reduce((n, f) => n + (f.size ?? 0), 0) > 10 * 1024 * 1024) throw new Error('Attachments must total 10 MiB or less, with at most 20 files.');
      const additions = [];
      for (const file of selectedFiles) {
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        additions.push({ name: file.name, size: file.size, type: file.type, data: btoa(binary) });
      }
      if (current()) { files.push(...additions); dirty = true; renderFiles(); }
    } catch (error) { if (current()) d('[data-result]').textContent = error.message; }
    finally { if (current()) { busy = false; lock(false); } }
  });
  async function download(id, partId) {
    const current = fence(); notice('Downloading attachment…');
    try {
      const { attachment: a } = await call({ action: 'attachment', id, partId }); if (!current()) return;
      const raw = atob(a.data.replaceAll('-', '+').replaceAll('_', '/')), bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })), link = document.createElement('a');
      link.href = url; link.download = a.name.replace(/[\\/\0]/g, '_'); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); notice('');
    } catch (error) { if (current()) notice(errorText(error)); }
  }
  async function conversation(threadId) {
    const current = fence(), turn = ++readTurn;
    try {
      const result = await call({ action: 'thread', threadId }); if (!current() || turn !== readTurn) return;
      const box = document.createElement('section'); box.setAttribute('aria-label', 'Conversation');
      for (const message of result.messages) { const details = document.createElement('details'), summary = document.createElement('summary'), body = document.createElement('div'); summary.textContent = message.from + ' · ' + message.date; if (message.html) body.innerHTML = message.html; else body.textContent = message.body; details.append(summary, body); button('Open message', () => read(message), details); box.append(details); }
      $('[data-reader]').append(box);
    } catch (error) { if (current()) notice(errorText(error)); }
  }
  async function removeDraft(m) {
    if (!confirm('Delete this Gmail draft?')) return;
    const current = fence();
    try { const result = await call({ action: 'draft-delete', draftId: m.draftId, expectedMessageId: m.id, requestId: crypto.randomUUID() }); if (!current()) return; if (result.state === 'accepted') { $('[data-reader]').replaceChildren(); await list(); } else notice('Deletion is unconfirmed. Refresh before trying again.'); }
    catch (error) { if (current()) notice(errorText(error)); }
  }
  async function connect(add) {
    const current = fence();
    try { const result = await api.request('/gmail/connect', { method: 'POST', data: { add, mailboxId: add ? null : status.id } }); if (!current()) return; const url = new URL(result.authorizationUrl); if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Invalid connection response.'); location.assign(url.href); }
    catch (error) { if (current()) notice(errorText(error)); }
  }
  $('[data-add]').addEventListener('click', () => connect(true)); $('[data-reconnect]').addEventListener('click', () => connect(false));
  $('[data-disconnect]').addEventListener('click', async () => {
    if (!confirm('Disconnect ' + status.address + '? Saved copies remain private.')) return;
    const current = fence();
    try { const result = await api.request('/gmail/disconnect', { method: 'POST', data: { mailboxId: status.id } }); if (!current()) return; controller.setStatus(result); onConnectionsChanged(); if (status?.state === 'connected') await list(); }
    catch (error) { if (current()) notice(errorText(error)); }
  });
  $('[data-mailbox]').addEventListener('change', () => {
    generation++; listTurn++; readTurn++; selected = null; status = allMailboxes.find(m => m.id === $('[data-mailbox]').value); $('[data-reader]').replaceChildren(); $('[data-list]').replaceChildren(); $('[data-address]').textContent = status.address; $('[data-compose]').disabled = !status.canWrite;
    if (status.state === 'connected') list(); else notice('Reconnect this Gmail account to continue.');
  });
  // Foreground refresh complements server history ticks. It never replaces an
  // open composer or steals focus from a reader/search control.
  setInterval(() => { if (!root.hidden && !panel.hidden && !document.hidden && !dialog.open && ownerKey()) list(); }, 60000);
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
  const controller = {
    setStatus(value) {
      allMailboxes = value.mailboxes ?? (value.address ? [value] : []);
      const next = allMailboxes.find(m => m.id === status?.id) ?? allMailboxes.find(m => m.state === 'connected') ?? allMailboxes[0] ?? null;
      if (status && (!next || status.id !== next.id || next.state !== 'connected')) this.reset(); status = next;
      $('[data-mailbox]').replaceChildren(...allMailboxes.map(m => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.address + (m.state === 'connected' ? '' : ' · reconnect'); return o; }));
      if (status) $('[data-mailbox]').value = status.id;
      $('[data-address]').textContent = status?.address ?? ''; $('[data-compose]').disabled = !status?.canWrite;
    },
    open() { if (!ownerKey() || status?.state !== 'connected') return; root.hidden = false; panel.classList.add('gmail-active'); $('[data-compose]').focus(); list(); },
    reset() { generation++; listTurn++; readTurn++; status = selected = editing = pending = null; busy = dirty = false; dialog.close(); form.reset(); files = []; richMode = false; d('[data-rich]').replaceChildren(); d('[data-files-list]').replaceChildren(); d('[data-from]').textContent = ''; d('[data-result]').textContent = ''; root.hidden = true; panel.classList.remove('gmail-active'); $('[data-list]').replaceChildren(); $('[data-reader]').replaceChildren(); $('[data-address]').textContent = ''; notice(''); }
  };
  return controller;
}
