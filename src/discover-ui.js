// Human room discovery UI. Renders the sanitized public room directory
// (GET /api/public/rooms/directory) as browsable cards with search, category
// filter, and pagination. Public data only: the endpoint already strips
// member, identity, and DM fields, and this page never sends credentials.
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const $ = id => document.getElementById(id);

const DIRECTORY = '/api/public/rooms/directory';
const PAGE_LIMIT = 50;
const MAX_CATEGORY_CHIPS = 12;

let rooms = [];
let cursor = null;
let query = '';
let activeKind = '';
let flight = null;

const grid = $('discover-grid');
const status = $('discover-status');
const search = $('discover-search');
const categories = $('discover-categories');
const moreButton = $('more-rooms');
const refreshButton = $('refresh-rooms');

const kindOf = room => {
  const kind = String(room.kind ?? '').trim().toLowerCase();
  return kind || 'other';
};

const memberLabel = count => {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0) return '';
  return n === 1 ? '1 member' : `${n} members`;
};

const listedLabel = listedAt => {
  const at = Number(listedAt);
  if (!Number.isFinite(at) || at <= 0) return '';
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return 'Listed today';
  if (days === 1) return 'Listed yesterday';
  if (days < 7) return `Listed ${days} days ago`;
  if (days < 30) { const w = Math.floor(days / 7); return w === 1 ? 'Listed 1 week ago' : `Listed ${w} weeks ago`; }
  if (days < 365) { const m = Math.floor(days / 30); return m === 1 ? 'Listed 1 month ago' : `Listed ${m} months ago`; }
  return `Listed ${new Date(at).getUTCFullYear()}`;
};

const roomHref = roomId => `/?room=${encodeURIComponent(String(roomId ?? ''))}`;

const cardHtml = room => {
  const kind = kindOf(room);
  const members = memberLabel(room.memberCount);
  const listed = listedLabel(room.listedAt);
  const meta = [members, listed].filter(Boolean).join(' · ');
  return `<li class="room-card"><span class="card-top"><span class="kind">${escape(kind)}</span></span>`
    + `<h3 class="card-title">${escape(room.title)}</h3>`
    + (room.purpose ? `<p class="card-purpose">${escape(room.purpose)}</p>` : '')
    + (meta ? `<p class="card-meta">${escape(meta)}</p>` : '')
    + `<a class="card-cta" href="${escape(roomHref(room.roomId))}">Open room <span aria-hidden="true">↗</span></a></li>`;
};

const matches = room => {
  if (activeKind && kindOf(room) !== activeKind) return false;
  if (!query) return true;
  const hay = `${room.title ?? ''} ${room.purpose ?? ''}`.toLowerCase();
  return hay.includes(query);
};

const renderCategories = () => {
  const counts = new Map();
  for (const room of rooms) {
    const kind = kindOf(room);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CATEGORY_CHIPS);
  if (activeKind && !top.some(([kind]) => kind === activeKind)) activeKind = '';
  categories.innerHTML = [`<button type="button" class="chip${activeKind === '' ? ' active' : ''}" data-kind="">All</button>`,
    ...top.map(([kind, count]) => `<button type="button" class="chip${kind === activeKind ? ' active' : ''}" data-kind="${escape(kind)}">${escape(kind)} <span class="chip-count">${count}</span></button>`)].join('');
};

const render = () => {
  renderCategories();
  const visible = rooms.filter(matches);
  grid.innerHTML = visible.map(cardHtml).join('');
  moreButton.hidden = cursor == null;
  if (!rooms.length) {
    status.textContent = 'No listed rooms yet. Check back soon.';
  } else if (!visible.length) {
    status.textContent = query || activeKind ? 'No rooms match your search.' : 'No listed rooms yet.';
  } else {
    status.textContent = `Showing ${visible.length} of ${rooms.length} listed room${rooms.length === 1 ? '' : 's'}.`;
  }
};

async function loadPage({ reset = false } = {}) {
  if (flight) return flight;
  status.textContent = reset ? 'Loading rooms…' : 'Loading more rooms…';
  const url = cursor && !reset ? `${DIRECTORY}?limit=${PAGE_LIMIT}&after=${encodeURIComponent(cursor)}` : `${DIRECTORY}?limit=${PAGE_LIMIT}`;
  flight = (async () => {
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`directory ${response.status}`);
    const page = await response.json();
    const entries = Array.isArray(page.rooms) ? page.rooms : [];
    rooms = reset ? entries : rooms.concat(entries);
    cursor = page.nextCursor ?? null;
  })();
  try {
    await flight;
  } catch {
    status.textContent = 'Couldn’t load rooms. Your place is saved — try again.';
    moreButton.hidden = true;
  } finally {
    flight = null;
  }
  render();
}

categories.addEventListener('click', event => {
  const button = event.target.closest('[data-kind]');
  if (!button) return;
  activeKind = button.dataset.kind ?? '';
  render();
});

let searchTimer = null;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    query = search.value.trim().toLowerCase();
    render();
  }, 150);
});

moreButton.addEventListener('click', () => loadPage());
refreshButton.addEventListener('click', () => { cursor = null; loadPage({ reset: true }); });

loadPage({ reset: true });
