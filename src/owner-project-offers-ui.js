// Owner-authored public terms only; no admission, credit reservation or payment.
import { roomPolicy } from './events.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const policies = { human: 'Human review', agent: 'Agent review', human_with_agent_review: 'Human + agent review' };
export function offerMinorUnits(raw, decimals) {
  if (!new RegExp(`^(0|[1-9][0-9]*)(?:\\.[0-9]{1,${decimals}})?$`).test(raw)) throw new Error(`Use a positive amount with up to ${decimals} decimal places.`);
  const [whole, fraction = ''] = raw.split('.');
  const amount = (whole + fraction.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
  if (amount === '0' || amount.length > 18) throw new Error('Use a positive amount within the offer limit.');
  return amount;
}
export function installOwnerProjectOffers({ client, getState, getSession, host }) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'topbar-button'; button.id = 'owner-offers-open'; button.textContent = 'Post work'; button.hidden = true;
  const dialog = document.createElement('dialog'); dialog.id = 'owner-offers-dialog'; dialog.setAttribute('aria-labelledby', 'owner-offers-title');
  dialog.innerHTML = `<div class="panel-header"><h2 id="owner-offers-title">Post work</h2><button type="button" id="owner-offers-close" class="button ghost">Close</button></div>
    <p class="form-hint">Publish clear terms for contributors. Posting does not reserve credits or arrange payment.</p>
    <form id="owner-offer-form"><label>Title<input name="title" required maxlength="200"></label><label>What should be delivered?<textarea name="summary" required rows="2" maxlength="4000"></textarea></label><label>Acceptance criteria · one per line<textarea name="criteria" required rows="3"></textarea></label>
    <label>Reward<select name="reward"><option value="unpaid">Unpaid</option><option value="credit">Work trade · internal credits</option><option value="USD">Cash · USD</option><option value="USDC">Cash · USDC</option></select></label><label id="owner-offer-amount" hidden>Proposed amount<input name="amount" inputmode="decimal" autocomplete="off"></label><p id="owner-offer-reward-note" class="form-hint">No payment offered.</p>
    <label>Approval<select name="approval"><option value="human">Human review</option><option value="agent">Agent review</option><option value="human_with_agent_review">Human + agent review</option></select></label><label id="owner-human-review">Human reviewer<select name="human"></select></label><label id="owner-agent-review" hidden>Agent reviewer<select name="agent"></select></label>
    <label>Public return link<input name="submission" type="url" placeholder="https://…"><span class="form-hint">Where contributors submit results. Required to publish unless a repository is provided below.</span></label>
    <details><summary>Additional scope</summary><label>Task or project<select name="kind"><option value="task">Task</option><option value="project">Project</option></select></label><label>Out of scope · one per line<textarea name="exclusions" rows="2"></textarea></label><label>Public repository<input name="repository" type="url" placeholder="https://…"></label><label>Deadline<input name="deadline" type="datetime-local"></label><label>Reward terms<textarea name="rewardTerms" rows="2" maxlength="2000"></textarea></label></details>
    <div class="form-actions"><button type="button" id="owner-offer-preview" class="button secondary">Preview public terms</button><button type="submit" id="owner-offer-save" class="button">Save draft</button></div></form>
    <section id="owner-offer-preview-view" hidden aria-label="Public preview"></section><p id="owner-offer-status" class="form-status" role="status"></p><button type="button" id="owner-offer-retry" class="button secondary" hidden>Retry same request</button>
    <hr><div class="panel-header"><h3>Your posted work</h3><button type="button" id="owner-offers-refresh" class="button ghost">Refresh</button></div><p class="form-hint">Terms stay fixed. For changed terms, create a replacement draft.</p><div id="owner-offers-list"></div>`;
  host.append(button); document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector), form = $('#owner-offer-form');
  let scope = null, epoch = 0, pending = null, busy = false, dirty = false, rows = [], reading = 0;
  const currentScope = () => { const state = getState(), session = getSession(); return state && session?.member?.id === state.room.ownerId && !state.room.archivedAt ? `${client.generation}:${state.room.id}:${session.member.id}` : null; };
  const owned = (version, binding) => version === epoch && binding === scope && scope === currentScope();
  const status = text => { $('#owner-offer-status').textContent = text; $('#owner-offer-status').classList.toggle('visible', Boolean(text)); };
  const controlState = () => { for (const input of form.elements) input.disabled = busy || Boolean(pending); $('#owner-offer-retry').hidden = !pending || busy; $('#owner-offers-refresh').disabled = busy; for (const action of $('#owner-offers-list').querySelectorAll('button')) action.disabled = busy || Boolean(pending); };
  function reset() { epoch++; reading++; scope = null; pending = null; busy = false; dirty = false; rows = []; form.reset(); $('#owner-offers-list').replaceChildren(); $('#owner-offer-preview-view').replaceChildren(); $('#owner-offer-preview-view').hidden = true; status(''); dialog.close(); button.hidden = true; controlState(); }
  function sync() { const next = currentScope(); if (scope && scope !== next) reset(); scope = next; button.hidden = !next; }
  function choices() {
    const state = getState();
    const members = Object.values(state.members).filter(member => member.active !== false);
    for (const [field, kind, permission] of [['human', 'human', 'decide'], ['agent', 'agent', 'verify']]) {
      const selected = form.elements[field].value;
      form.elements[field].innerHTML = `<option value="">Choose a reviewer</option>` + members.filter(member => member.kind === kind && member.permissions.includes(permission)).map(member => `<option value="${escape(member.id)}">${escape(member.displayName)}</option>`).join('');
      if (members.some(member => member.id === selected)) form.elements[field].value = selected;
    }
    const requiresHuman = roomPolicy(state).requireOwnerDecision;
    form.elements.approval.querySelector('[value="agent"]').disabled = requiresHuman;
    if (requiresHuman && form.elements.approval.value === 'agent') form.elements.approval.value = 'human_with_agent_review';
    if (requiresHuman) form.elements.human.value = state.room.ownerId;
    fields();
  }
  function fields() {
    const reward = form.elements.reward.value, mode = form.elements.approval.value;
    $('#owner-offer-amount').hidden = reward === 'unpaid'; form.elements.amount.required = reward !== 'unpaid';
    $('#owner-human-review').hidden = mode === 'agent'; $('#owner-agent-review').hidden = mode === 'human';
    form.elements.human.required = mode !== 'agent'; form.elements.agent.required = mode !== 'human';
    $('#owner-offer-reward-note').textContent = reward === 'credit' ? 'Proposed internal credits · not reserved and no cashout.' : reward === 'unpaid' ? 'No payment offered.' : 'Cash funding and payment are not configured. These are proposed terms.';
  }
  function payload() {
    const value = name => form.elements[name].value.trim();
    const lines = name => value(name).split('\n').map(line => line.trim()).filter(Boolean);
    const mode = value('approval'), unit = value('reward'), reward = unit === 'unpaid' ? { kind: 'unpaid' } : { kind: unit === 'credit' ? 'work_trade' : 'cash', unit, amountMinor: offerMinorUnits(value('amount'), unit === 'USD' ? 2 : unit === 'USDC' ? 6 : 3), basis: 'fixed' };
    if (value('rewardTerms')) reward.terms = value('rewardTerms');
    const terms = { kind: value('kind'), title: value('title'), summary: value('summary'), acceptanceCriteria: lines('criteria'), exclusions: lines('exclusions'), reward, approvalPolicy: { mode } };
    if (!terms.title || !terms.summary || !terms.acceptanceCriteria.length || terms.acceptanceCriteria.length > 20 || terms.exclusions.length > 20 || [...terms.acceptanceCriteria, ...terms.exclusions].some(line => line.length > 1000)) throw new Error('Add a title, deliverable and up to 20 criteria or exclusions, each within 1000 characters.');
    for (const [field, key] of [['submission', 'submissionUrl'], ['repository', 'repositoryUrl']]) if (value(field)) { const url = new URL(value(field)); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use public HTTPS links without credentials, query or fragment.'); terms[key] = url.href; }
    if (!terms.submissionUrl && !terms.repositoryUrl) throw new Error('Add a public return link or repository before saving. Saved terms stay fixed.');
    if (value('deadline')) terms.deadline = new Date(value('deadline')).toISOString();
    const reviewerMemberIds = [...new Set([...(mode !== 'agent' ? [value('human')] : []), ...(mode !== 'human' ? [value('agent')] : [])])];
    if (reviewerMemberIds.some(id => !id)) throw new Error('Choose the required reviewers.');
    return { terms, reviewerMemberIds };
  }
  function preview() { try { const { terms } = payload(); const section = $('#owner-offer-preview-view'); section.replaceChildren(); const title = document.createElement('h3'); title.textContent = terms.title; const body = document.createElement('p'); body.textContent = terms.summary; const list = document.createElement('ul'); for (const criterion of terms.acceptanceCriteria) { const item = document.createElement('li'); item.textContent = criterion; list.append(item); } const note = document.createElement('p'); note.textContent = `${policies[terms.approvalPolicy.mode]} · ${$('#owner-offer-reward-note').textContent}`; const details = document.createElement('p'); details.textContent = [terms.kind, terms.reward.kind === 'unpaid' ? 'Unpaid' : `${form.elements.amount.value} ${terms.reward.unit}`, terms.reward.terms, terms.submissionUrl, terms.repositoryUrl, terms.deadline, ...terms.exclusions.map(value => `Out of scope: ${value}`)].filter(Boolean).join(' · '); section.append(title, body, list, note, details); section.hidden = false; status('Preview only. Save a draft before publishing.'); } catch (error) { status(error.message); } }
  function rewardLabel(reward) {
    if (reward.kind === 'unpaid') return 'Unpaid';
    const padded = reward.amountMinor.padStart(reward.decimals + 1, '0');
    return `${padded.slice(0, -reward.decimals)}.${padded.slice(-reward.decimals)} ${reward.unit}${reward.basis === 'pool' ? ' pool' : ''}`;
  }
  function paintRows() {
    $('#owner-offers-list').innerHTML = rows.length ? rows.map(row => `<section><h4>${escape(row.title)}</h4><p>${escape(row.status)} · terms v${row.version} · ${escape(policies[row.approvalPolicy.mode])} · ${escape(rewardLabel(row.reward))}</p><details><summary>Read saved terms</summary><p>${escape(row.summary)}</p><ul>${row.acceptanceCriteria.map(value => `<li>${escape(value)}</li>`).join('')}</ul>${row.exclusions.length ? `<p>Out of scope: ${row.exclusions.map(escape).join('; ')}</p>` : ''}<p>${escape(row.submissionUrl || row.repositoryUrl)}</p><p>${escape(row.reward.terms)} ${row.reward.kind === 'cash' ? 'Cash payment is not configured.' : row.reward.kind === 'work_trade' ? 'Credits are not reserved.' : ''}</p></details>${row.status === 'draft' ? `<button type="button" class="button secondary" data-publish="${escape(row.id)}">Publish</button>` : row.status === 'published' ? `<a href="/offers?offer=${encodeURIComponent(row.id)}" target="_blank" rel="noopener noreferrer">View public offer</a> <button type="button" class="button secondary" data-withdraw="${escape(row.id)}">Withdraw</button>` : ''}</section>`).join('') : '<p class="form-hint">No offers yet.</p>';
    controlState();
  }
  async function refresh() {
    const version = epoch, binding = scope, request = ++reading;
    try { const result = await client.request(client.path('/project-offers')); if (!owned(version, binding) || request !== reading) return; if (!Array.isArray(result.offers) || result.offers.length > 100) throw new Error('Unsupported offer response'); rows = result.offers; paintRows(); }
    catch { if (owned(version, binding) && request === reading) status('Couldn’t refresh your offers. Try Refresh.'); }
  }
  async function execute() {
    if (busy || !pending || !scope || scope !== currentScope()) return;
    busy = true; controlState(); status('Saving…'); const version = epoch, binding = scope, request = pending;
    try {
      const result = await client.request(request.path, { method: 'POST', data: request.data });
      if (!owned(version, binding) || pending !== request) return;
      if (result?.schema !== 'project-room-offer/1' || result.id !== request.offerId || !['draft', 'published', 'withdrawn'].includes(result.status)) throw new Error('Unsupported offer receipt');
      pending = null;
      if (request.action === 'create') { dirty = false; form.reset(); choices(); $('#owner-offer-preview-view').hidden = true; status('Draft saved. Review it below, then publish when ready.'); }
      else status(result.status === 'published' ? 'Published.' : 'Withdrawn from public discovery.');
      rows = [result, ...rows.filter(row => row.id !== result.id)]; paintRows();
    } catch (error) {
      if (!owned(version, binding) || pending !== request) return;
      if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 408) { pending = null; status(error.status === 409 ? 'This offer changed. Refresh before trying again.' : 'Couldn’t save. Check the terms and your current owner/reviewer access, then try again.'); }
      else status('The response was interrupted. Retry the same request to confirm what was saved; your terms are kept.');
    } finally { if (owned(version, binding)) { busy = false; controlState(); } }
  }
  form.addEventListener('input', () => { dirty = true; }); form.addEventListener('change', fields);
  form.addEventListener('submit', event => { event.preventDefault(); if (busy || pending) return; try { const data = payload(), offerId = crypto.randomUUID(); pending = { action: 'create', offerId, path: client.path('/project-offers'), data: { requestId: crypto.randomUUID(), offerId, ...data } }; void execute(); } catch (error) { status(error.message); } });
  $('#owner-offer-preview').addEventListener('click', preview); $('#owner-offer-retry').addEventListener('click', () => void execute()); $('#owner-offers-refresh').addEventListener('click', () => void refresh());
  $('#owner-offers-list').addEventListener('click', event => {
    const target = event.target.closest('[data-publish],[data-withdraw]'); if (!target || busy || pending) return;
    const action = target.dataset.publish ? 'publish' : 'withdraw', offerId = target.dataset.publish || target.dataset.withdraw, row = rows.find(item => item.id === offerId);
    if (!row) return;
    pending = { action, offerId, path: client.path(`/project-offers/${encodeURIComponent(offerId)}/${action}`), data: { requestId: crypto.randomUUID(), expectedRevision: row.revision } }; void execute();
  });
  function close() { if (busy) return; dialog.close(); button.focus(); }
  $('#owner-offers-close').addEventListener('click', close); dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => { if (event.key !== 'Tab') return; const controls = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href]')].filter(element => element.getClientRects().length); const first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); } });
  button.addEventListener('click', () => { sync(); if (!scope) return; host.closest('details')?.removeAttribute('open'); if (!pending) choices(); dialog.showModal(); form.elements.title.focus(); void refresh(); });
  return { sync, reset, hasPending: () => busy || Boolean(pending) || dirty, hasUnknown: () => Boolean(pending) && !busy };
}
