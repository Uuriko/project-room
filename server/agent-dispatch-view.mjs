// Human dispatch page. No controls. Names only, never member ids.
import { DARK_DECLARATIONS, LIGHT_DECLARATIONS } from "../src/design-tokens.js";
import { escapeHtml } from "./html-escape.mjs";

export const DISPATCH_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const pageStyle = () => `:root{color-scheme:dark;${DARK_DECLARATIONS}}[data-theme="light"]{color-scheme:light;${LIGHT_DECLARATIONS}}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.55 var(--font-sans)}
main{max-width:40rem;margin:0 auto;padding:2rem 1.25rem 3rem}
h1{font-size:clamp(1.6rem,5vw,2.1rem);line-height:1.15;letter-spacing:-.03em;margin:0 0 .4rem}
h2{font-size:1.05rem;margin:1.6rem 0 .4rem}
p,li{overflow-wrap:anywhere}
.meta{color:var(--muted);margin:0}
ul{margin:.2rem 0 0;padding-left:1.1rem}
li{margin:.35rem 0}`;

const pct = value => `${Math.round((Number(value) || 0) * 100)}%`;

function seatLine(view) {
  if (view.paused) return "The room owner paused assignment.";
  if (view.seat?.mode !== "agent") return "No agent has claimed the coordinator seat. The fallback is assigning.";
  const name = view.capacity.find(agent => agent.memberId === view.seat.memberId)?.displayName;
  return name ? `${name} holds the coordinator seat.` : "An agent holds the coordinator seat.";
}

export function renderDispatchHtml(view) {
  const metrics = view.metrics ?? { busyShare: 0, mergedPerDay: 0, duplicateRate: 0, collisionRate: 0, perAgent: [], busyShareBasis: "now" };
  const agents = metrics.perAgent ?? [];
  const agentList = agents.length
    ? `<ul>${agents.map(agent => `<li>${escapeHtml(agent.displayName)} is ${escapeHtml(agent.status)}, ${escapeHtml(String(agent.mergedPerDay))} merged per day.</li>`).join("")}</ul>`
    : `<p>No agents have joined this room. Capacity shows up when an agent member is here.</p>`;
  const basis = metrics.busyShareBasis === "window" ? "over the last 7 days" : "right now";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dispatch</title>
<meta name="robots" content="noindex">
<style>${pageStyle()}</style>
</head><body><main>
<h1>Dispatch</h1>
<p class="meta">${escapeHtml(seatLine(view))}</p>
<h2>Capacity</h2>
<p>${escapeHtml(pct(metrics.busyShare))} of agent time is busy ${escapeHtml(basis)}. ${escapeHtml(String(metrics.mergedPerDay))} merged per day across the room.</p>
${agentList}
<h2>Overlap</h2>
<p>Duplicate rate ${escapeHtml(pct(metrics.duplicateRate))}. Collision rate ${escapeHtml(pct(metrics.collisionRate))}.</p>
</main></body></html>`;
}
