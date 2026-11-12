import { createWorkBrief } from '../client/work-brief.mjs';
import { createWorkContinuation, workContinuationMarkdown } from './work-continuation.js';
import { clipboard } from './clipboard.js';

// Only an authenticated selected-work read is projected. No writes or new store.
export function installContinuation({ client, getState }) {
  const $ = id => document.getElementById(id), dialog = $('continuation-dialog');
  let entry = null, epoch = 0, copying = false;
  const owns = ticket => Boolean(ticket && entry === ticket && ticket.epoch === epoch && dialog.open
    && client.generation === ticket.generation && client.session === ticket.session && client.ownsAccountSession()
    && getState()?.room?.id === ticket.session.roomId);
  const stale = ticket => ticket?.basis == null || getState()?.workItems?.[ticket.workId]?.revision !== ticket.basis;
  const setStatus = text => { $('continuation-status').textContent = text; $('continuation-status').classList.toggle('visible', Boolean(text)); };
  function controls() {
    const valid = owns(entry), changed = valid && entry.basis != null && stale(entry);
    $('continuation-copy').disabled = !valid || entry.loading || changed || copying || clipboard.busy || !$('continuation-preview').value;
    $('continuation-refresh').disabled = !valid || entry.loading || copying || clipboard.busy;
    if (changed && $('continuation-status').textContent !== 'Work changed during copy. Refresh and copy again.') setStatus('Work changed. Refresh before copying.');
  }
  function reset() {
    epoch++; entry = null; $('continuation-preview').value = ''; setStatus('');
    if (dialog.open) dialog.close();
  }
  function close() { const opener = entry?.opener; reset(); if (opener?.isConnected) opener.focus({ preventScroll: true }); }
  async function refresh(ticket) {
    if (!owns(ticket) || ticket.loading) return;
    ticket.loading = true; ticket.basis = null; $('continuation-preview').value = ''; setStatus('Loading…'); controls();
    try {
      const context = await client.workContext(ticket.workId);
      if (!owns(ticket) || !context) return;
      const brief = await createWorkBrief(context);
      if (!owns(ticket)) return;
      const markdown = workContinuationMarkdown(createWorkContinuation(brief));
      if (!owns(ticket)) return;
      ticket.basis = context.work.revision; $('continuation-preview').value = markdown;
      setStatus(stale(ticket) ? 'Work changed. Refresh before copying.' : '');
    } catch (error) { if (owns(ticket)) setStatus(error.message || 'Could not load work. Try again.'); }
    finally { if (owns(ticket)) { ticket.loading = false; controls(); } }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-continue-work]');
    if (!button || dialog.open || !client.session || !client.ownsAccountSession()) return;
    const state = getState(), workId = button.dataset.continueWork;
    if (state?.room?.id !== client.session.roomId || !Object.hasOwn(state.workItems, workId)) return;
    entry = { epoch: ++epoch, generation: client.generation, session: client.session, workId, opener: button, loading: false, basis: null };
    dialog.showModal(); controls(); void refresh(entry);
  });
  $('continuation-close').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  $('continuation-refresh').addEventListener('click', () => { void refresh(entry); });
  $('continuation-copy').addEventListener('click', async () => {
    const ticket = entry;
    if (!owns(ticket) || stale(ticket) || copying || clipboard.busy || !$('continuation-preview').value) return;
    copying = true; controls();
    try {
      const result = await clipboard.copy($('continuation-preview').value);
      if (!owns(ticket)) return;
      if (stale(ticket)) setStatus('Work changed during copy. Refresh and copy again.');
      else if (result === 'copied') setStatus('Copied. Paste into your agent.');
      else if (result === 'pending') setStatus('Copy is still in progress.');
      else { setStatus('Select the continuation and copy it manually.'); $('continuation-preview').focus(); $('continuation-preview').select(); }
    } finally { copying = false; controls(); }
  });
  clipboard.subscribe(controls);
  return { reset, sync() { if (entry && !owns(entry)) reset(); else controls(); } };
}
