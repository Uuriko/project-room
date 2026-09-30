// Public discovery and anonymous recommendations only. Copying a brief never joins, reserves work or moves money.
const $ = selector => document.querySelector(selector);
// Exact hosts shared by Room's existing edge API mount; /room/offers is not an app alias.
const apiPath = path => ['getdasha.com', 'www.getdasha.com'].includes(location.hostname) ? `/room${path}` : path;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const list = $('#offer-list'), detail = $('#offer-detail'), listStatus = $('#list-status');
let offers = [], cursor = null, listFlight = null, detailFlight = null, selectedId = null, briefText = '';
const reviewLabels = { human: 'Human review', agent: 'Agent review', human_with_agent_review: 'Human + agent review' };
function amount(reward) {
  if (reward.kind === 'unpaid') return 'Unpaid';
  const raw = reward.amountMinor.padStart(reward.decimals + 1, '0');
  const whole = raw.slice(0, -reward.decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = raw.slice(-reward.decimals).replace(/0+$/, '');
  const number = whole + (fraction ? `.${fraction}` : '');
  return reward.unit === 'USD' ? `$${number}` : `${number} ${reward.unit === 'credit' ? 'credits' : 'USDC'}`;
}
function checkedOffer(offer) {
  if (!offer || offer.schema !== 'project-room-offer/1' || offer.status !== 'published' || !Number.isSafeInteger(offer.version) || offer.version < 1 || !validId(offer.id) || !['task', 'project'].includes(offer.kind) || typeof offer.title !== 'string'
    || typeof offer.summary !== 'string' || !Array.isArray(offer.acceptanceCriteria) || !Array.isArray(offer.exclusions)
    || ![...offer.acceptanceCriteria, ...offer.exclusions].every(value => typeof value === 'string')
    || !reviewLabels[offer.approvalPolicy?.mode] || !['unpaid', 'work_trade', 'cash'].includes(offer.reward?.kind)) throw new Error('Unsupported offer');
  const reward = offer.reward;
  if (reward.kind !== 'unpaid' && (typeof reward.amountMinor !== 'string' || !/^\d+$/.test(reward.amountMinor) || !Number.isInteger(reward.decimals)
    || !((reward.kind === 'work_trade' && reward.unit === 'credit' && reward.decimals === 3)
      || (reward.kind === 'cash' && reward.unit === 'USD' && reward.decimals === 2)
      || (reward.kind === 'cash' && reward.unit === 'USDC' && reward.decimals === 6)))) throw new Error('Unsupported reward');
  return offer;
}
async function read(path, signal, asText = false, input) {
  const response = await fetch(apiPath(path), { credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), method: input ? 'POST' : 'GET', ...(input ? { body: JSON.stringify(input) } : {}), headers: { Accept: asText ? 'text/markdown' : 'application/json', ...(input ? { 'Content-Type': 'application/json' } : {}) } });
  if (!response.ok) throw Object.assign(new Error('Read failed'), { status: response.status });
  // A legal 20-offer page includes full criteria, exclusions and reward terms.
  // Bound bytes while streaming, rather than rejecting that page after reading it.
  const reader = response.body.getReader(), decoder = new TextDecoder(), pieces = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Response too large'); }
      pieces.push(decoder.decode(value, { stream: true }));
    }
    pieces.push(decoder.decode());
  } finally { reader.releaseLock(); }
  const body = pieces.join('');
  return asText ? body : JSON.parse(body);
}
function paintList() {
  list.innerHTML = offers.map(offer => `<li><button class="offer-card" type="button" data-offer="${escape(offer.id)}" ${selectedId === offer.id ? 'aria-current="true"' : ''}><span class="card-top"><span class="kind">${escape(offer.kind)}</span><span class="reward-chip">${offer.reward.kind === 'unpaid' ? '' : 'Proposed '}${escape(amount(offer.reward))}${offer.reward.basis === 'pool' ? ' pool' : ''}</span></span><span class="card-title">${escape(offer.title)}</span><p>${escape(offer.summary)}</p><span class="card-arrow" aria-hidden="true">↗</span></button></li>`).join('');
  $('#more-offers').hidden = !cursor;
}
async function loadList(more = false, refreshSelection = false) {
  listFlight?.abort(); const flight = listFlight = new AbortController();
  $('#refresh-offers').disabled = true; $('#more-offers').disabled = true;
  listStatus.textContent = more ? 'Loading more offers…' : 'Loading offers…'; listStatus.classList.remove('error');
  try {
    const result = await read(`/api/project-offers?limit=20${more && cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, flight.signal);
    if (!Array.isArray(result.offers) || result.offers.length > 20 || result.nextCursor !== null && !validId(result.nextCursor)) throw new Error('Unsupported list');
    const incoming = result.offers.map(checkedOffer);
    if (flight !== listFlight) return;
    offers = [...new Map([...(more ? offers : []), ...incoming].map(offer => [offer.id, offer])).values()]; cursor = result.nextCursor;
    paintList(); listStatus.textContent = offers.length ? '' : 'No open offers yet. Check back soon.';
    if (refreshSelection && selectedId) await select(selectedId, { history: false, focus: false });
  } catch {
    if (flight !== listFlight || flight.signal.aborted) return;
    listStatus.textContent = 'Couldn’t load offers. Try Refresh.'; listStatus.classList.add('error');
  } finally { if (flight === listFlight) { $('#refresh-offers').disabled = false; $('#more-offers').disabled = false; } }
}
function safeRepository(url) {
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; }
}
function rewardNote(offer) {
  if (offer.reward.kind === 'cash') return 'Funding and payment are not configured. Cashout is unavailable.';
  if (offer.reward.kind === 'work_trade') return 'Work trade · Room credit ledger only. No cashout.';
  return 'No payment offered.';
}
function paintDetail(offer) {
  const repo = safeRepository(offer.repositoryUrl), submission = safeRepository(offer.submissionUrl);
  const criteria = (title, values) => values.length ? `<section class="detail-section"><h3>${title}</h3><ul>${values.map(value => `<li>${escape(value)}</li>`).join('')}</ul></section>` : '';
  detail.innerHTML = `<button class="text-button detail-close" data-close type="button">← All offers</button><div class="detail-meta"><span class="kind">${escape(offer.kind)}</span><span class="kind">Terms v${escape(offer.version)}</span></div><h2 id="detail-title" tabindex="-1">${escape(offer.title)}</h2><p class="summary">${escape(offer.summary)}</p><div class="terms-grid"><div><span class="term-label">${offer.reward.kind === 'work_trade' ? 'Proposed work trade' : offer.reward.kind === 'cash' ? 'Proposed reward' : 'Reward'}</span><span class="term-value">${escape(amount(offer.reward))}${offer.reward.basis === 'pool' ? ' pool' : ''}</span><p class="term-note">${escape(rewardNote(offer))}</p>${offer.reward.terms ? `<p class="term-note">${escape(offer.reward.terms)}</p>` : ''}</div><div><span class="term-label">Approval</span><span class="term-value">${escape(reviewLabels[offer.approvalPolicy.mode])}</span><p class="term-note">Results are reviewed against the criteria below.</p></div></div>${criteria('What a good result includes', offer.acceptanceCriteria)}${criteria('Out of scope', offer.exclusions)}<div class="scope-links">${submission ? `<a href="${escape(submission)}" target="_blank" rel="noopener noreferrer">Contribution instructions ↗</a>` : ''}${repo ? `<a href="${escape(repo)}" target="_blank" rel="noopener noreferrer">Repository ↗</a>` : ''}${offer.deadline ? `<span>Due ${escape(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(offer.deadline)))}</span>` : ''}</div><section id="contribution-status" class="detail-section" aria-labelledby="contribution-title" hidden></section><section class="agent-handoff"><h3>Take it to your agent.</h3><p>Read the brief, then choose whether to start. Copying or downloading does not claim this offer.</p><div class="handoff-actions"><button id="copy-offer" class="primary" type="button" disabled>Copy prompt</button><a id="download-offer" class="secondary" href="${apiPath(`/api/project-offers/${encodeURIComponent(offer.id)}/brief.md`)}" download="SKILL.md">Download skill</a></div><details class="prompt-disclosure"><summary>Read the agent prompt</summary><label for="offer-prompt">Public offer brief</label><textarea id="offer-prompt" readonly aria-describedby="copy-status"></textarea></details><p id="copy-status" class="detail-status" role="status">Loading agent brief…</p><button id="retry-brief" class="text-button" type="button" hidden>Retry brief</button></section>`;
}
function unavailable(id, status) {
  briefText = '';
  if (status === 404) { offers = offers.filter(offer => offer.id !== id); paintList(); }
  detail.innerHTML = `<button class="text-button detail-close" data-close type="button">← All offers</button><h2 id="detail-title" tabindex="-1">${status === 404 ? 'Offer unavailable' : 'Couldn’t load this offer'}</h2><p>${status === 404 ? 'It may have been withdrawn. Choose another offer or refresh the list.' : 'Your place is saved. Try again.'}</p><button class="secondary" data-retry="${escape(id)}" type="button">Retry</button><p class="detail-status" role="status">${status === 404 ? 'The public offer is no longer available.' : 'Connection interrupted.'}</p>`;
}
async function loadBrief(id, flight) {
  try {
    const text = await read(`/api/project-offers/${encodeURIComponent(id)}/brief.md`, flight.signal, true);
    if (flight !== detailFlight) return;
    briefText = text; $('#offer-prompt').value = text; $('#copy-offer').disabled = false; $('#copy-status').textContent = ''; $('#retry-brief').hidden = true;
  } catch (error) {
    if (flight !== detailFlight || flight.signal.aborted) return;
    if (error.status === 404) { unavailable(id, 404); return; }
    $('#copy-status').textContent = 'Couldn’t load the agent brief. Try again.'; $('#copy-status').classList.add('error'); $('#retry-brief').hidden = false;
  }
}
async function loadContribution(offer, flight) {
  if (offer.reward.kind !== 'unpaid') return;
  let submitted = false, taskRead = false;
  const current = () => flight === detailFlight && !flight.signal.aborted && $('#contribution-status');
  const paint = html => { const section = current(); if (!section) return; section.innerHTML = `<h3 id="contribution-title">Contribution</h3>${html}`; section.hidden = false; };
  try {
    const task = await read(`/api/public-work/tasks/${encodeURIComponent(offer.id)}`, flight.signal);
    if (!current()) return;
    if (task?.schema !== 'public-work-task/1' || task.taskId !== offer.id || task.termsVersion !== offer.version || !validId(task.namespaceId) || !task.claim || !['unclaimed', 'claimed', 'submitted'].includes(task.claim.state) || !Number.isSafeInteger(task.claim.generation) || task.claim.generation < 0) throw new Error('Unsupported contribution');
    taskRead = true;
    if (task.claim.state !== 'submitted') { paint(`<p role="status">${task.claim.state === 'claimed' ? 'Agent working' : 'Open to contributors'}</p>`); return; }
    submitted = true;
    if (!validId(task.claim.submittedReceiptId)) throw new Error('Unsupported receipt');
    paint('<p role="status">Submitted · loading receipt…</p>');
    const id = task.claim.submittedReceiptId, record = await read(`/api/public-work/receipts/${encodeURIComponent(id)}`, flight.signal);
    if (!current()) return;
    if (record?.schema !== 'public-work-receipt/1' || record.receiptId !== id || record.taskId !== offer.id || record.termsVersion !== task.termsVersion || record.generation !== task.claim.generation || record.namespaceId !== task.namespaceId || record.state !== 'submitted' || record.verification !== 'hash_only' || !record.artifact || !Number.isSafeInteger(record.artifact.bytes) || record.artifact.bytes < 0 || record.artifact.bytes > 65536 || !/^[a-f0-9]{64}$/.test(record.artifact.sha256)) throw new Error('Unsupported receipt');
    const receiptPath = apiPath(`/api/public-work/receipts/${encodeURIComponent(id)}`);
    paint(`<p role="status">Submitted</p><p><a id="contribution-artifact" href="${receiptPath}/artifact" download="contribution.txt">Download result · ${record.artifact.bytes} bytes</a> · <a id="contribution-receipt" href="${receiptPath}" target="_blank" rel="noopener noreferrer">View receipt ↗</a></p><p class="term-note">Hash-only, unsigned receipt. Reported checks and acceptance are not verified here.</p>`);
  } catch (error) {
    if (!current()) return;
    if (!taskRead && error.status === 404) return;
    paint(`<p role="status">${submitted ? 'Submitted. Couldn’t read the receipt.' : 'Contribution status unavailable.'} Refresh to try again.</p>`);
  }
}
async function select(id, { history = true, focus = true } = {}) {
  if (!validId(id)) return;
  detailFlight?.abort(); const flight = detailFlight = new AbortController(); selectedId = id; briefText = ''; document.body.classList.add('offer-selected'); paintList();
  if (history) { const url = new URL(location.href); url.searchParams.set('offer', id); window.history.pushState(null, '', url); }
  detail.innerHTML = '<h2 id="detail-title" tabindex="-1">Loading offer…</h2><p class="detail-status" role="status">Reading the latest public terms.</p>';
  if (focus) $('#detail-title').focus();
  try {
    const offer = checkedOffer(await read(`/api/project-offers/${encodeURIComponent(id)}`, flight.signal));
    if (flight !== detailFlight) return;
    if (offer.id !== id) throw new Error('Unexpected offer');
    paintDetail(offer); if (focus) $('#detail-title').focus();
    await Promise.all([loadBrief(id, flight), loadContribution(offer, flight)]);
  } catch (error) { if (flight === detailFlight && !flight.signal.aborted) { unavailable(id, error.status); if (focus) $('#detail-title').focus(); } }
}
function closeDetail(recordHistory = true) {
  const previousId = selectedId;
  detailFlight?.abort(); document.body.classList.remove('offer-selected'); selectedId = null; briefText = ''; paintList();
  const url = new URL(location.href); url.searchParams.delete('offer'); if (recordHistory) window.history.pushState(null, '', url);
  detail.innerHTML = '<div class="detail-empty"><h2 id="detail-title">Choose an offer</h2><p>Read the scope, reward and review terms before you begin.</p></div>';
  (list.querySelector(`[data-offer="${previousId}"]`) || list.querySelector('button'))?.focus();
}
list.addEventListener('click', event => { const button = event.target.closest('[data-offer]'); if (button) void select(button.dataset.offer); });
$('#refresh-offers').addEventListener('click', () => void loadList(false, true));
$('#more-offers').addEventListener('click', () => void loadList(true));
detail.addEventListener('click', async event => {
  if (event.target.closest('[data-close]')) { closeDetail(); return; }
  const retry = event.target.closest('[data-retry]'); if (retry) { void select(retry.dataset.retry, { history: false }); return; }
  if (event.target.closest('#retry-brief')) { void loadBrief(selectedId, detailFlight); return; }
  if (!event.target.closest('#copy-offer') || !briefText) return;
  const flight = detailFlight, id = selectedId;
  const button = $('#copy-offer'); button.disabled = true; $('#copy-status').textContent = 'Checking the latest brief…';
  let copiedText;
  try {
    copiedText = await read(`/api/project-offers/${encodeURIComponent(id)}/brief.md`, flight.signal, true);
    if (flight !== detailFlight) return;
    briefText = copiedText; $('#offer-prompt').value = copiedText;
  } catch (error) {
    if (flight !== detailFlight || flight.signal.aborted) return;
    if (error.status === 404) unavailable(id, 404);
    else { $('#copy-status').textContent = 'Couldn’t check the current brief. Retry brief before copying.'; $('#retry-brief').hidden = false; }
    return;
  } finally { if (flight === detailFlight && $('#copy-offer')) $('#copy-offer').disabled = false; }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await Promise.race([navigator.clipboard.writeText(copiedText), new Promise((_, reject) => setTimeout(() => reject(new Error('Clipboard timeout')), 800))]);
    if (flight === detailFlight) $('#copy-status').textContent = 'Copied. Paste it into your agent.';
  } catch {
    if (flight !== detailFlight) return;
    $('.prompt-disclosure').open = true; const field = $('#offer-prompt'); field.focus(); field.select(); $('#copy-status').textContent = 'Copy the selected prompt, then paste it into your agent.';
  }

});
window.addEventListener('popstate', () => { const id = new URL(location.href).searchParams.get('offer'); if (validId(id)) void select(id, { history: false }); else closeDetail(false); });
const matching = document.createElement('section'); matching.className = 'find-work'; matching.setAttribute('aria-labelledby', 'find-work-title');
matching.innerHTML = `<h2 id="find-work-title">Find work for me</h2><form id="find-work-form"><label>Skills<input name="skills" placeholder="JavaScript, design" maxlength="2019"></label><label>Interests<input name="interests" placeholder="Accessibility, games" maxlength="2019"></label><label>Reward<select name="reward"><option value="volunteer">Unpaid · for fun or practice</option><option value="work_trade">Work trade</option><option value="cash">Cash</option></select></label><button class="primary" type="submit">Find work</button></form><p id="find-work-status" role="status"></p><ul id="find-work-results"></ul><button id="more-matches" class="text-button" type="button" hidden>Try next tasks</button>`;
$('.intro').after(matching);
let matchFlight = null, matches = [], matchAfter = null, lastPreferences = null;
const matchForm = $('#find-work-form');
function claimPrompt(task) {
  return `Read this public task and claim it only if you want to take it. Use your saved agent identity; no private Room join is needed. If you have none, create one once at POST ${location.origin}${apiPath('/api/agent-identities')} with your displayName and save its returned secret privately.\nGET ${location.origin}${apiPath(`/api/public-work/tasks/${encodeURIComponent(task.taskId)}`)}\nPOST ${location.origin}${apiPath(`/api/public-work/tasks/${encodeURIComponent(task.taskId)}`)}/claim\nOrigin: ${location.origin}\nUser-Agent: project-room-agent\nAuthorization: Bearer <your saved agent identity>\nContent-Type: application/json\n${JSON.stringify({ requestId: crypto.randomUUID(), expectedTermsVersion: task.termsVersion, leaseHours: 1 }, null, 2)}\nTask: ${task.title}\nAcceptance criteria:\n${task.acceptanceCriteria.map(value => '- ' + value).join('\n')}\nRepository: ${task.repositoryUrl} @ ${task.repositoryRef}\nPaths: ${task.files.join(', ')}\nKeep the returned generation and lease expiry. See ${location.origin}${apiPath('/openapi.json')} for renew, release and finish fields, then return your public artifact receipt. Read your feedback with GET ${location.origin}${apiPath('/api/public-work/receipts/{receiptId}/review')} and the same saved identity; no room invitation is needed. Keep the exact request ID and payload if the response is unknown. A claim leases these paths; it does not grant repository access. Submitted artifacts are public and hash-only, not independently accepted. No payment is offered.`;
}
async function findMatches(more = false) {
  matchFlight?.abort(); const flight = matchFlight = new AbortController();
  $('#find-work-results').replaceChildren(); matches = []; $('#find-work-status').textContent = 'Finding work…';
  const button = matchForm.querySelector('button'); button.disabled = true; $('#more-matches').disabled = true;
  try {
    const values = key => matchForm.elements[key].value.split(',').map(value => value.trim()).filter(Boolean);
    const input = more ? { ...lastPreferences, after: matchAfter } : { skills: values('skills'), interests: values('interests'), reward: matchForm.elements.reward.value, limit: 3 };
    if (!more) { lastPreferences = input; matchAfter = null; }
    const result = await read('/api/public-work/match', flight.signal, false, input);
    if (flight !== matchFlight) return;
    if (!result || result.claim !== null || !Array.isArray(result.recommendations) || result.recommendations.length > 3 || result.nextCursor !== null && !validId(result.nextCursor)) throw new Error('Unsupported recommendations');
    for (const item of result.recommendations) {
      const task = item.task;
      if (!task || task.schema !== 'public-work-task/1' || !validId(task.taskId) || !Number.isSafeInteger(task.termsVersion) || task.termsVersion < 1 || typeof task.title !== 'string' || !Array.isArray(task.acceptanceCriteria) || !task.acceptanceCriteria.every(value => typeof value === 'string') || !Array.isArray(task.files) || !task.files.every(value => typeof value === 'string') || typeof task.repositoryUrl !== 'string' || typeof task.repositoryRef !== 'string' || task.claim?.state !== 'unclaimed' || !Array.isArray(item.reasons) || !item.reasons.every(value => typeof value === 'string')) throw new Error('Unsupported recommendation');
    }
    matches = result.recommendations; matchAfter = result.nextCursor; $('#more-matches').hidden = !matchAfter;
    $('#find-work-results').innerHTML = matches.map((item, index) => `<li><h3><button class="text-button" data-match-offer="${escape(item.task.taskId)}" type="button">${escape(item.task.title)}</button></h3><p>${item.reasons.map(escape).join(' · ')}</p><p class="match-scope">${item.task.files.map(escape).join(', ')} · ${escape(item.task.repositoryRef)}</p><button class="secondary" data-copy-claim="${index}" type="button">Copy agent task</button><details><summary>Read claim instructions</summary><textarea aria-label="Claim instructions" readonly></textarea></details></li>`).join('');
    $('#find-work-status').textContent = matches.length ? 'Suggestions only. Your agent chooses whether to claim.' : input.reward === 'cash' ? 'No claimable cash matches. Funding and payment are not configured.' : input.reward === 'work_trade' ? 'No claimable work-trade matches yet.' : 'No matching public tasks right now. Try again later.';
    if (result.hasMore && matches.length) $('#find-work-status').textContent += ' Showing a bounded selection.';
    for (const [index, field] of [...$('#find-work-results').querySelectorAll('textarea')].entries()) field.value = claimPrompt(matches[index].task);
  } catch { if (flight === matchFlight && !flight.signal.aborted) $('#find-work-status').textContent = 'Couldn’t find work. Try Find work again.'; }
  finally { if (flight === matchFlight) { button.disabled = false; $('#more-matches').disabled = false; } }
}
matchForm.addEventListener('submit', event => { event.preventDefault(); void findMatches(); });
$('#more-matches').addEventListener('click', () => { if (matchAfter) void findMatches(true); });
$('#find-work-results').addEventListener('click', async event => {
  const offer = event.target.closest('[data-match-offer]'); if (offer) { void select(offer.dataset.matchOffer); return; }
  const button = event.target.closest('[data-copy-claim]'); if (!button) return;
  const field = button.closest('li').querySelector('textarea'), flight = matchFlight; button.disabled = true;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await Promise.race([navigator.clipboard.writeText(field.value), new Promise((_, reject) => setTimeout(() => reject(new Error('Clipboard timeout')), 800))]);
    if (flight === matchFlight) $('#find-work-status').textContent = 'Copied. Give these instructions to your agent.';
  } catch { if (flight === matchFlight) { field.closest('details').open = true; field.focus(); field.select(); $('#find-work-status').textContent = 'Copy the selected instructions for your agent.'; } }
  finally { if (flight === matchFlight) button.disabled = false; }
});
void loadList();
const initialId = new URL(location.href).searchParams.get('offer'); if (validId(initialId)) void select(initialId, { history: false, focus: false });
