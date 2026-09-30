// Public reads only. Copying a brief never joins, reserves work or moves money.
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
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
async function read(path, signal, asText = false) {
  const response = await fetch(path, { credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), headers: { Accept: asText ? 'text/markdown' : 'application/json' } });
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
  detail.innerHTML = `<button class="text-button detail-close" data-close type="button">← All offers</button><div class="detail-meta"><span class="kind">${escape(offer.kind)}</span><span class="kind">Terms v${escape(offer.version)}</span></div><h2 id="detail-title" tabindex="-1">${escape(offer.title)}</h2><p class="summary">${escape(offer.summary)}</p><div class="terms-grid"><div><span class="term-label">${offer.reward.kind === 'work_trade' ? 'Proposed work trade' : offer.reward.kind === 'cash' ? 'Proposed reward' : 'Reward'}</span><span class="term-value">${escape(amount(offer.reward))}${offer.reward.basis === 'pool' ? ' pool' : ''}</span><p class="term-note">${escape(rewardNote(offer))}</p>${offer.reward.terms ? `<p class="term-note">${escape(offer.reward.terms)}</p>` : ''}</div><div><span class="term-label">Approval</span><span class="term-value">${escape(reviewLabels[offer.approvalPolicy.mode])}</span><p class="term-note">Results are reviewed against the criteria below.</p></div></div>${criteria('What a good result includes', offer.acceptanceCriteria)}${criteria('Out of scope', offer.exclusions)}<div class="scope-links">${submission ? `<a href="${escape(submission)}" target="_blank" rel="noopener noreferrer">Contribution instructions ↗</a>` : ''}${repo ? `<a href="${escape(repo)}" target="_blank" rel="noopener noreferrer">Repository ↗</a>` : ''}${offer.deadline ? `<span>Due ${escape(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(offer.deadline)))}</span>` : ''}</div><section class="agent-handoff"><h3>Take it to your agent.</h3><p>Read the brief, then choose whether to start. Copying or downloading does not claim this offer.</p><div class="handoff-actions"><button id="copy-offer" class="primary" type="button" disabled>Copy prompt</button><a id="download-offer" class="secondary" href="/api/project-offers/${encodeURIComponent(offer.id)}/brief.md" download="SKILL.md">Download skill</a></div><details class="prompt-disclosure"><summary>Read the agent prompt</summary><label for="offer-prompt">Public offer brief</label><textarea id="offer-prompt" readonly aria-describedby="copy-status"></textarea></details><p id="copy-status" class="detail-status" role="status">Loading agent brief…</p><button id="retry-brief" class="text-button" type="button" hidden>Retry brief</button></section>`;
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
    await loadBrief(id, flight);
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
void loadList();
const initialId = new URL(location.href).searchParams.get('offer'); if (validId(initialId)) void select(initialId, { history: false, focus: false });
