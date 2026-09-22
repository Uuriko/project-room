// Account-owned setup. OAuth resumes from the persisted step; no mailbox data
// or answers are kept in browser storage.
export function installAccountSetup({ api, owns, onInbox, gmailNotice = "" }) {
  const dialog = document.createElement('dialog'); dialog.id = 'account-setup-dialog'; dialog.className = 'account-setup-dialog';
  dialog.setAttribute('aria-labelledby', 'account-setup-title'); document.body.append(dialog);
  let current = null, busy = false, generation = 0, checked = false;
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  const button = (label, action, primary = false) => { const b = el('button', label, 'button ' + (primary ? 'primary' : 'ghost')); b.type = 'button'; b.onclick = action; return b; };
  async function save(patch) {
    const response = await api.request('/setup', { method: 'POST', data: { ...current, ...patch } });
    current = response.setup;
  }
  async function run(action) {
    if (busy || !owns()) return;
    busy = true; const turn = generation;
    const buttons = [...dialog.querySelectorAll('button')].map(b => [b, b.disabled]);
    buttons.forEach(([b]) => { b.disabled = true; });
    try { await action(); }
    catch { if (turn === generation && owns()) dialog.querySelector('[role=status]').textContent = 'Couldn’t save this step. Please try again.'; }
    finally { if (turn === generation && owns()) { busy = false; buttons.forEach(([b, disabled]) => { if (b.isConnected) b.disabled = disabled; }); } }
  }
  function render() {
    if (!owns() || !current) return;
    const step = current.step;
    let answers = () => ({});
    const progress = el('p', `Step ${step + 1} of 3`, 'form-hint');
    const title = el('h2', ['Make Project Room yours', 'Connect your email', 'You’re ready'][step]); title.id = 'account-setup-title'; title.tabIndex = -1;
    const status = el('p', '', 'form-hint'); status.setAttribute('role', 'status');
    const content = el('div', '', 'account-setup-content'), actions = el('div', '', 'account-setup-actions');
    if (step === 0) {
      const label = el('label', 'What should we call you?'); const name = el('input'); name.id = 'setup-name'; name.maxLength = 80; name.autocomplete = 'name'; name.value = current.name; label.append(name); content.append(label);
      const field = el('label', 'What will you use Project Room for?'); const purpose = el('select'); purpose.id = 'setup-purpose';
      for (const [value, text] of [['personal', 'My projects and messages'], ['team', 'Working with a team'], ['agents', 'Working with AI agents'], ['', 'I’m exploring']]) { const o = el('option', text); o.value = value; purpose.append(o); }
      purpose.value = current.purpose; field.append(purpose); content.append(field);
      answers = () => ({ name: name.value.trim(), purpose: purpose.value });
      actions.append(button('Continue', () => run(async () => { await save({ name: name.value.trim(), purpose: purpose.value, step: 1 }); render(); }), true));
    } else if (step === 1) {
      content.append(el('p', 'Read, send, and organize Gmail here.'));
      if (gmailNotice) content.append(el('p', gmailNotice, 'form-hint'));
      const connection = el('p', 'Checking Gmail…', 'form-hint'); content.append(connection);
      const connect = button('Connect Gmail', () => run(async () => {
        await save({ platforms: ['Gmail'] });
        const result = await api.request('/gmail/connect', { method: 'POST', data: {} });
        const url = new URL(result.authorizationUrl);
        if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Invalid provider');
        location.assign(url.href);
      }), true);
      connect.disabled = true; content.append(connect);
      const next = button('Skip', () => run(async () => { await save({ step: 2 }); render(); }));
      const turn = generation;
      api.request('/gmail').then(value => {
        if (turn !== generation || !owns() || !connection.isConnected) return;
        connection.textContent = value.state === 'unavailable' ? 'Gmail isn’t available for this account yet.' : value.state === 'connected' ? `Connected: ${value.address}` : '';
        connect.disabled = value.state === 'unavailable' || value.state === 'connected';
        connect.hidden = value.state === 'unavailable' || value.state === 'connected';
        connection.hidden = !connection.textContent;
        if (value.state === 'connected') { next.textContent = 'Continue'; next.className = 'button primary'; }
      }).catch(() => { if (connection.isConnected) connection.textContent = 'Couldn’t check Gmail. Try again later.'; });
      actions.append(button('Back', () => run(async () => { await save({ step: 0 }); render(); })), next);
    } else {
      content.append(el('p', 'Your inbox is private. Choose what to share when you bring a message into a room.'));
      actions.append(button('Back', () => run(async () => { await save({ step: 1 }); render(); })), button('Open my inbox', () => run(async () => { await save({ completed: true }); dialog.close(); onInbox(); }), true));
    }
    if (step !== 1) actions.append(button('Set up later', () => run(async () => { await save({ ...answers(), completed: true }); dialog.close(); })));
    dialog.replaceChildren(progress, title, content, status, actions);
    if (!dialog.open) dialog.showModal(); title.focus();
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); run(async () => { await save({ completed: true }); dialog.close(); }); });
  return {
    async check(force = false) {
      if (!owns() || checked && !force) return; checked = true;
      const turn = generation;
      try {
        const value = await api.request('/setup'); if (turn !== generation || !owns()) return;
        current = value.setup;
        if (force || !current.completed) render();
      } catch { if (turn === generation) checked = false; }
    },
    reset() { generation++; checked = false; busy = false; current = null; dialog.close(); dialog.replaceChildren(); }
  };
}
