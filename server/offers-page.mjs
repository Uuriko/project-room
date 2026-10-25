// Server-rendered offers shelf (DOOR-CURE-3).
// The /offers page used to serve only a JS shell: the served HTML held
// zero offers and a no-JS stranger (or a non-executing crawler) saw only
// "Enable JavaScript to browse offers…". The receipts wall
// (server/receipts-page.mjs) is the pattern: the same public set the API
// serves is rendered into the HTML at read time, and the client script
// stays as an enhancement that repaints the list from the live API.
// Every interpolated string is escaped: titles and summaries are
// owner-authored room data.
import { escapeHtml } from "./html-escape.mjs";

// The reward label, mirroring src/project-offers-ui.js amount(): the
// server card must say exactly what the client card would say.
export function offerRewardLabel(reward) {
  if (!reward || reward.kind === "unpaid") return "Unpaid";
  const decimals = Number.isInteger(reward.decimals) ? reward.decimals : 0;
  const raw = String(reward.amountMinor ?? "0").padStart(decimals + 1, "0");
  const whole = (decimals ? raw.slice(0, -decimals) : raw).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = decimals ? raw.slice(-decimals).replace(/0+$/, "") : "";
  const number = whole + (fraction ? `.${fraction}` : "");
  const amount = reward.unit === "USD" ? `$${number}` : `${number} ${reward.unit === "credit" ? "credits" : "USDC"}`;
  return `${reward.kind === "unpaid" ? "" : "Proposed "}${amount}${reward.basis === "pool" ? " pool" : ""}`.trim();
}

const when = value => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
};

// One server-rendered card. The title links to the JS detail view
// (/offers?offer=<id>, which project-offers-ui.js selects on load) and
// the brief link is the no-JS readable path: the public brief document
// the API already serves for this offer.
export function renderOfferCardHtml(offer) {
  const id = escapeHtml(offer.id);
  const deadline = offer.deadline ? `<span>Due ${escapeHtml(when(offer.deadline))}</span>` : "";
  return `<li><article class="offer-card server-offer-card"><span class="card-top"><span class="kind">${escapeHtml(offer.kind)}</span><span class="reward-chip">${escapeHtml(offerRewardLabel(offer.reward))}</span></span><span class="card-title"><a href="/offers?offer=${id}">${escapeHtml(offer.title)}</a></span><p>${escapeHtml(offer.summary)}</p><span class="card-links">${deadline}<a href="/api/project-offers/${id}/brief.md">Read the brief</a></span></article></li>`;
}

export function renderOffersListHtml(page) {
  const offers = Array.isArray(page?.offers) ? page.offers : [];
  if (!offers.length) return `<li class="server-offer-empty">No open tasks right now — <a href="/receipts">see work already done</a>.</li>`;
  return offers.map(renderOfferCardHtml).join("");
}

// Inject the server-rendered shelf into the packaged offers.html shell.
// The shell's markers are the exact elements the client script owns:
// #offer-list (repainted by paintList() on load), #list-status, and
// #more-offers. A shell without the list marker is not this page's
// shell (a partial package, a test fixture) — serve it unchanged rather
// than failing the door.
export function renderOffersHtml(shell, page) {
  const html = String(shell ?? "");
  const listMarker = `<ul id="offer-list" class="offer-list"></ul>`;
  if (!html.includes(listMarker)) return html;
  const offers = Array.isArray(page?.offers) ? page.offers : [];
  let out = html.replace(listMarker, `<ul id="offer-list" class="offer-list">${renderOffersListHtml(page)}</ul>`);
  // The status line: with JS it is repainted by loadList(); without JS
  // it must not claim the shelf is still loading.
  out = out.replace(`<p id="list-status" role="status" hidden>Loading offers…</p>`,
    offers.length
      ? `<p id="list-status" role="status">${offers.length} open offer${offers.length === 1 ? "" : "s"} shown. Use Refresh for the latest.</p>`
      : `<p id="list-status" role="status">No open offers right now.</p>`);
  // Pagination without JS: the API cursor becomes a plain link. The JS
  // "Show more" button stays hidden for no-JS readers, who follow this.
  if (page?.nextCursor) {
    const more = `<p class="server-offer-more"><a href="/offers?after=${escapeHtml(page.nextCursor)}">More offers</a></p>`;
    out = out.replace(`<button id="more-offers" class="secondary" type="button" hidden>Show more</button>`,
      `<button id="more-offers" class="secondary" type="button" hidden>Show more</button>${more}`);
  }
  return out;
}
