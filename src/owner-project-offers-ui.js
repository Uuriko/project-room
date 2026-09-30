// Owner-authored public terms only; no admission, credit reservation or payment.
import { roomPolicy, validId } from './events.js';
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
  dialog.innerHTML = `<div class="panel-header"><h2 id="owner-offers-title">Post work</h2><button type="button" id="owner-results-open" class="button ghost">Results</button><button type="button" id="owner-offers-close" class="button ghost">Close</button></div>
    <p class="form-hint">Publish clear terms for contributors. Posting does not reserve credits or arrange payment.</p>
    <form id="owner-offer-form"><label>Title<input name="title" required maxlength="200"></label><label>What should be delivered?<textarea name="summary" required rows="2" maxlength="4000"></textarea></label><label>Acceptance criteria · one per line<textarea name="criteria" required rows="3"></textarea></label>
    <label>Reward<select name="reward"><option value="unpaid">Unpaid</option><option value="credit">Work trade · internal credits</option><option value="USD">Cash · USD</option><option value="USDC">Cash · USDC</option></select></label><label id="owner-offer-amount" hidden>Proposed amount<input name="amount" inputmode="decimal" autocomplete="off"></label><p id="owner-offer-reward-note" class="form-hint">No payment offered.</p>
    <label>Approval<select name="approval"><option value="human">Human review</option><option value="agent">Agent review</option><option value="human_with_agent_review">Human + agent review</option></select></label><label id="owner-human-review">Human reviewer<select name="human"></select></label><label id="owner-agent-review" hidden>Agent reviewer<select name="agent"></select></label>
    <label>Public return link<input name="submission" type="url" placeholder="https://…"><span class="form-hint">Where contributors return work; add this or a repository.</span></label>
    <details><summary>Additional scope</summary><label>Task or project<select name="kind"><option value="task">Task</option><option value="project">Project</option></select></label><label>Out of scope · one per line<textarea name="exclusions" rows="2"></textarea></label><label>Public repository<input name="repository" type="url" placeholder="https://…"></label><label>Deadline<input name="deadline" type="datetime-local"></label><label>Reward terms<textarea name="rewardTerms" rows="2" maxlength="2000"></textarea></label></details>
    <div class="form-actions"><button type="button" id="owner-offer-preview" class="button secondary">Preview public terms</button><button type="submit" id="owner-offer-save" class="button">Save draft</button></div></form>
    <section id="owner-offer-preview-view" hidden aria-label="Public preview"></section><p id="owner-offer-status" class="form-status" role="status"></p><button type="button" id="owner-offer-retry" class="button secondary" hidden>Retry same request</button>
    <form id="owner-public-claims-form" hidden><h3 id="owner-public-claims-title">Open to contributors</h3><p class="form-hint">Outside agents can claim these paths and submit public artifacts. Repository access stays separate.</p><label>Branch or commit<input name="repositoryRef" required maxlength="128" placeholder="main"></label><label>Files or folders · one per line<textarea name="files" required rows="3" placeholder="src/welcome.js"></textarea></label><div class="form-actions"><button type="submit" class="button">Enable contributions</button><button type="button" id="owner-public-claims-cancel" class="button ghost">Cancel</button></div></form>
    <hr><div class="panel-header"><h3>Your posted work</h3><button type="button" id="owner-offers-refresh" class="button ghost">Refresh</button></div><p class="form-hint">Terms stay fixed. For changed terms, create a replacement draft.</p><div id="owner-offers-list"></div><details id="owner-results-section"><summary>Results</summary><div class="panel-header"><h3>Submitted results</h3><button type="button" id="owner-results-refresh" class="button ghost">Refresh results</button></div><p id="owner-results-status" class="form-hint" role="status"></p><div id="owner-results-list"></div><button type="button" id="owner-results-more" class="button secondary" hidden>Show more results</button></details>`;
  host.append(button); document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector), form = $('#owner-offer-form'), claimForm = $('#owner-public-claims-form');
  let scope = null, epoch = 0, pending = null, busy = false, dirty = false, rows = [], reading = 0, enablingId = null, claimDirty = false, results = [], resultCursor = null, resultReading = 0, resultsLoaded = false, resultsFresh = false;
  const resultDrafts = new Map();
  const currentScope = () => { const state = getState(), session = getSession(); return state && session?.member?.id === state.room.ownerId && !state.room.archivedAt ? `${client.generation}:${state.room.id}:${session.member.id}` : null; };
  const owned = (version, binding) => version === epoch && binding === scope && scope === currentScope();
  const status = text => { $('#owner-offer-status').textContent = text; $('#owner-offer-status').classList.toggle('visible', Boolean(text)); };
  const controlState = () => { for (const input of [...form.elements, ...claimForm.elements]) input.disabled = busy || Boolean(pending); $('#owner-offer-retry').hidden = !pending || busy; $('#owner-offers-refresh').disabled = busy; for (const action of $('#owner-offers-list').querySelectorAll('button')) action.disabled = busy || Boolean(pending); $('#owner-results-refresh').disabled = busy; $('#owner-results-more').disabled = busy; syncResultControls(); };
  function reset() { epoch++; reading++; resultReading++; results = []; resultCursor = null; resultsLoaded = false; resultsFresh = false; resultDrafts.clear(); $('#owner-results-list').replaceChildren(); $('#owner-results-status').textContent = ''; $('#owner-results-section').open = false; $('#owner-results-more').hidden = true; scope = null; pending = null; busy = false; dirty = false; rows = []; form.reset(); claimForm.reset(); claimForm.hidden = true; enablingId = null; claimDirty = false; $('#owner-offers-list').replaceChildren(); $('#owner-offer-preview-view').replaceChildren(); $('#owner-offer-preview-view').hidden = true; status(''); dialog.close(); button.hidden = true; controlState(); }
  function sync() { const next = currentScope(); if (scope && scope !== next) reset(); scope = next; button.hidden = !next; syncResultControls(); }
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
    $('#owner-offers-list').innerHTML = rows.length ? rows.map(row => `<section><h4>${escape(row.title)}</h4><p>${escape(row.status)} · terms v${row.version} · ${escape(policies[row.approvalPolicy.mode])} · ${escape(rewardLabel(row.reward))}</p><details><summary>Read saved terms</summary><p>${escape(row.summary)}</p><ul>${row.acceptanceCriteria.map(value => `<li>${escape(value)}</li>`).join('')}</ul>${row.exclusions.length ? `<p>Out of scope: ${row.exclusions.map(escape).join('; ')}</p>` : ''}<p>${escape(row.submissionUrl || row.repositoryUrl)}</p><p>${escape(row.reward.terms)} ${row.reward.kind === 'cash' ? 'Cash payment is not configured.' : row.reward.kind === 'work_trade' ? 'Credits are not reserved.' : ''}</p></details>${row.status === 'draft' ? `<button type="button" class="button secondary" data-publish="${escape(row.id)}">Publish</button>` : row.status === 'published' ? `<a href="/offers?offer=${encodeURIComponent(row.id)}" target="_blank" rel="noopener noreferrer">View public offer</a> <button type="button" class="button secondary" data-withdraw="${escape(row.id)}">Withdraw</button>${row.publicClaims?.enabled ? '<p>Public claims enabled.</p>' : row.reward.kind === 'unpaid' && row.repositoryUrl ? `<button type="button" class="button secondary" data-enable-claims="${escape(row.id)}">Open to contributors</button>` : ''}` : ''}</section>`).join('') : '<p class="form-hint">No offers yet.</p>';
    controlState();
  }
  async function refresh() {
    const version = epoch, binding = scope, request = ++reading;
    try { const result = await client.request(client.path('/project-offers')); if (!owned(version, binding) || request !== reading) return; if (!Array.isArray(result.offers) || result.offers.length > 100) throw new Error('Unsupported offer response'); rows = result.offers; paintRows(); }
    catch { if (owned(version, binding) && request === reading) status('Couldn’t refresh your offers. Try Refresh.'); }
  }
  async function execute() {
    if (busy || !pending || !scope || scope !== currentScope()) return;
    // Any list captured before this write may be obsolete, even on retry.
    reading++; resultReading++;
    busy = true; controlState(); status('Saving…'); const version = epoch, binding = scope, request = pending;
    try {
      const result = await client.request(request.path, { method: 'POST', data: request.data });
      if (!owned(version, binding) || pending !== request) return;
      if (request.action === 'review') {
        checkedResult(result);
        if (result.receipt.receiptId !== request.receiptId || result.review.revision !== request.data.expectedReviewRevision + 1 || result.review.state !== request.data.decision || result.review.decision?.reason !== request.data.reason || result.receipt.taskId !== request.data.taskId || result.receipt.termsVersion !== request.data.expectedTermsVersion || result.receipt.generation !== request.data.generation || result.receipt.artifact.sha256 !== request.data.artifactSha256) throw new Error('Unsupported review receipt');
        resultReading++; pending = null; resultDrafts.delete(request.receiptId); resultsFresh = true; resultsLoaded = true;
        results = [result, ...results.filter(row => row.receipt.receiptId !== request.receiptId)]; paintResults(); status('Review recorded. Feedback is available to the contributor.'); return;
      }
      if (request.action === 'enable') {
        if (result?.schema !== 'public-work-task/1' || result.taskId !== request.offerId || result.termsVersion !== request.data.expectedTermsVersion || !Array.isArray(result.files) || typeof result.repositoryRef !== 'string') throw new Error('Unsupported public claim receipt');
        reading++; pending = null; claimDirty = false; claimForm.reset(); claimForm.hidden = true; enablingId = null;
        rows = rows.map(row => row.id === result.taskId ? { ...row, publicClaims: { enabled: true, repositoryRef: result.repositoryRef, files: result.files } } : row);
        paintRows(); status('Public claims enabled. Share the public offer with contributors.'); return;
      }
      if (result?.schema !== 'project-room-offer/1' || result.id !== request.offerId || !['draft', 'published', 'withdrawn'].includes(result.status)) throw new Error('Unsupported offer receipt');
      // The receipt outranks reads started while the mutation was pending.
      reading++;
      pending = null;
      if (request.action === 'create') { dirty = false; form.reset(); choices(); $('#owner-offer-preview-view').hidden = true; status('Draft saved. Review it below, then publish when ready.'); }
      else status(result.status === 'published' ? 'Published.' : 'Withdrawn from public discovery.');
      rows = [result, ...rows.filter(row => row.id !== result.id)]; paintRows();
    } catch (error) {
      if (!owned(version, binding) || pending !== request) return;
      if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 408) { pending = null; if (request.action === 'review') resultsFresh = false; status(error.status === 409 ? request.action === 'review' ? 'This review changed or needs current reviewer evidence. Refresh results before deciding.' : 'This offer changed. Refresh before trying again.' : request.action === 'review' ? 'Couldn’t record the review. Check your current reviewer access and feedback, then refresh results.' : 'Couldn’t save. Check the terms and your current owner/reviewer access, then try again.'); }
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
  claimForm.addEventListener('input', () => { claimDirty = true; });
  claimForm.addEventListener('submit', event => {
    event.preventDefault(); if (busy || pending) return;
    const row = rows.find(item => item.id === enablingId); if (!row || row.status !== 'published' || row.reward.kind !== 'unpaid' || !row.repositoryUrl) return;
    pending = { action: 'enable', offerId: row.id, path: client.path(`/project-offers/${encodeURIComponent(row.id)}/claims`), data: { requestId: crypto.randomUUID(), expectedRevision: row.revision, expectedTermsVersion: row.version, repositoryRef: claimForm.elements.repositoryRef.value.trim(), files: claimForm.elements.files.value.split('\n').map(value => value.trim()).filter(Boolean) } }; void execute();
  });
  $('#owner-public-claims-cancel').addEventListener('click', () => { if (busy || pending) return; const id = enablingId; enablingId = null; claimDirty = false; claimForm.reset(); claimForm.hidden = true; $('#owner-offers-list').querySelector(`[data-enable-claims="${CSS.escape(id)}"]`)?.focus(); });
  $('#owner-offers-list').addEventListener('click', event => {
    const target = event.target.closest('[data-enable-claims]'); if (!target || busy || pending) return;
    enablingId = target.dataset.enableClaims; claimDirty = false; claimForm.reset(); claimForm.hidden = false; claimForm.elements.repositoryRef.focus();
  });
  const resultStates = { pending: 'Review pending', accepted: 'Accepted', rejected: 'Rejected', revision_requested: 'Revision requested' };
  function checkedResult(row) {
    const receipt = row?.receipt, review = row?.review, authority = row?.authority;
    if (!receipt || receipt.schema !== 'public-work-receipt/1' || !validId(receipt.receiptId) || !validId(receipt.taskId) || receipt.state !== 'submitted' || receipt.verification !== 'hash_only' || !Number.isSafeInteger(receipt.termsVersion) || receipt.termsVersion < 1 || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1 || !receipt.artifact || !/^[a-f0-9]{64}$/.test(receipt.artifact.sha256) || !Number.isSafeInteger(receipt.artifact.bytes) || receipt.artifact.bytes < 0 || receipt.artifact.bytes > 65536 || !row.offer || row.offer.id !== receipt.taskId || typeof row.offer.title !== 'string' || !['published', 'withdrawn'].includes(row.offer.status) || !Object.hasOwn(policies, row.offer.approvalPolicy?.mode ?? '') || !review || review.schema !== 'public-work-review/1' || review.receiptId !== receipt.receiptId || review.taskId !== receipt.taskId || review.termsVersion !== receipt.termsVersion || review.generation !== receipt.generation || review.artifactSha256 !== receipt.artifact.sha256 || !Number.isSafeInteger(review.revision) || review.revision < 0 || !Object.hasOwn(resultStates, review.state) || !authority || !['canDecide', 'canVerify', 'acceptReady'].every(key => typeof authority[key] === 'boolean') || typeof authority.reason !== 'string') throw new Error('Unsupported result');
    return row;
  }
  function canDecide(row) {
    const member = getState()?.members?.[getSession()?.member?.id];
    return resultsFresh && row.authority.canDecide && member?.active !== false && member?.kind === 'human' && member.permissions?.includes('decide') && scope === currentScope();
  }
  function syncResultControls() {
    for (const section of $('#owner-results-list').querySelectorAll('[data-result-receipt]')) {
      const row = results.find(item => item.receipt.receiptId === section.dataset.resultReceipt); if (!row) continue;
      const allowed = canDecide(row);
      for (const action of section.querySelectorAll('[data-review-decision]')) { action.hidden = !allowed || action.dataset.reviewDecision === 'accepted' && !row.authority.acceptReady; action.disabled = busy || Boolean(pending); }
      const note = section.querySelector('[data-review-note]'); if (note) { note.hidden = !allowed; note.querySelector('[data-review-feedback]').disabled = busy || Boolean(pending); }
    }
  }
  function paintResults() {
    $('#owner-results-list').innerHTML = results.map(row => {
      const id = row.receipt.receiptId, review = row.review, evidence = review.verification;
      const api = ['getdasha.com', 'www.getdasha.com'].includes(location.hostname) ? '/room/api' : '/api';
      return `<section data-result-receipt="${escape(id)}"><h4>${escape(row.offer.title)}</h4><p>${escape(resultStates[review.state])}${row.offer.status === 'withdrawn' ? ' · Offer withdrawn' : ''} · ${escape(policies[row.offer.approvalPolicy.mode])}</p><p><a href="${api}/public-work/receipts/${encodeURIComponent(id)}/artifact" download="contribution.txt">Download result · ${row.receipt.artifact.bytes} bytes</a> · <a href="${api}/public-work/receipts/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer">View receipt</a></p>${evidence ? `<p>Reviewer check: ${escape(evidence.verdict)}${evidence.verdict === 'PASS' && evidence.current === false ? ' · needs fresh review' : ''}</p><p>${escape(evidence.reason)}</p>` : ''}${review.decision ? `<p>${escape(review.decision.reason)}</p>` : ''}<p class="form-hint">${escape(row.authority.reason)}</p>${review.state === 'revision_requested' ? '<p class="form-hint">This submission stays immutable. A new claim is not opened automatically.</p>' : ''}<label data-review-note>Feedback for contributor<textarea data-review-feedback required maxlength="2000" rows="2" aria-label="Feedback for contributor"></textarea></label><div class="form-actions"><button type="button" class="button" data-review-decision="accepted">Accept result</button><button type="button" class="button secondary" data-review-decision="revision_requested">Request revision</button><button type="button" class="button ghost" data-review-decision="rejected">Reject result</button></div></section>`;
    }).join('');
    for (const section of $('#owner-results-list').querySelectorAll('[data-result-receipt]')) section.querySelector('[data-review-feedback]').value = resultDrafts.get(section.dataset.resultReceipt) ?? '';
    $('#owner-results-more').hidden = !resultCursor; syncResultControls();
  }
  async function refreshResults(more = false) {
    if (!scope || busy || more && !resultCursor) return;
    const version = epoch, binding = scope, request = ++resultReading; resultsFresh = false; syncResultControls(); $('#owner-results-status').textContent = 'Reading submitted results…';
    try {
      const result = await client.request(client.path(`/public-work/results?limit=20${more ? `&after=${encodeURIComponent(resultCursor)}` : ''}`));
      if (!owned(version, binding) || request !== resultReading) return;
      if (!Array.isArray(result.results) || result.results.length > 20 || result.nextCursor !== null && !validId(result.nextCursor)) throw new Error('Unsupported results');
      const incoming = result.results.map(checkedResult);
      results = [...new Map([...(more ? results : []), ...incoming].map(row => [row.receipt.receiptId, row])).values()]; resultCursor = result.nextCursor; resultsLoaded = true; resultsFresh = true;
      paintResults(); $('#owner-results-status').textContent = results.length ? 'Review the artifact against its criteria before deciding. Accepted and rejected decisions are final.' : 'No submitted results yet.';
    } catch { if (owned(version, binding) && request === resultReading) $('#owner-results-status').textContent = 'Couldn’t read results. Try Refresh results.'; }
  }
  $('#owner-results-section').addEventListener('toggle', () => { if ($('#owner-results-section').open && !resultsLoaded) void refreshResults(); });
  $('#owner-results-open').addEventListener('click', () => { $('#owner-results-section').open = true; $('#owner-results-section').querySelector('summary').focus(); $('#owner-results-section').scrollIntoView({ block: 'start' }); });
  $('#owner-results-refresh').addEventListener('click', () => void refreshResults()); $('#owner-results-more').addEventListener('click', () => void refreshResults(true));
  $('#owner-results-list').addEventListener('input', event => { const input = event.target.closest('[data-review-feedback]'); if (input) resultDrafts.set(input.closest('[data-result-receipt]').dataset.resultReceipt, input.value); });
  $('#owner-results-list').addEventListener('click', event => {
    const action = event.target.closest('[data-review-decision]'); if (!action || busy || pending) return;
    const section = action.closest('[data-result-receipt]'), row = results.find(item => item.receipt.receiptId === section.dataset.resultReceipt); if (!row || !canDecide(row) || action.dataset.reviewDecision === 'accepted' && !row.authority.acceptReady) return;
    const input = section.querySelector('[data-review-feedback]'); if (!input.reportValidity()) return;
    pending = { action: 'review', receiptId: row.receipt.receiptId, path: client.path(`/public-work/receipts/${encodeURIComponent(row.receipt.receiptId)}/decide`), data: { requestId: crypto.randomUUID(), expectedReviewRevision: row.review.revision, taskId: row.receipt.taskId, expectedTermsVersion: row.receipt.termsVersion, generation: row.receipt.generation, artifactSha256: row.receipt.artifact.sha256, decision: action.dataset.reviewDecision, reason: input.value.trim() } }; void execute();
  });
  function close() { if (busy) return; dialog.close(); button.focus(); }
  $('#owner-offers-close').addEventListener('click', close); dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => { if (event.key !== 'Tab') return; const controls = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href]')].filter(element => element.getClientRects().length); const first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); } });
  button.addEventListener('click', () => { sync(); if (!scope) return; host.closest('details')?.removeAttribute('open'); if (!pending) choices(); dialog.showModal(); form.elements.title.focus(); void refresh(); });
  return { sync, reset, hasPending: () => busy || Boolean(pending) || dirty || claimDirty || [...resultDrafts.values()].some(value => value.trim()), hasUnknown: () => Boolean(pending) && !busy };
}
