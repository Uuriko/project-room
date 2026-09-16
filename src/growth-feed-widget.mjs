// Track C slice C16 — activity feed UI widget (G002).
//
// renderGrowthFeed(summary) turns a frozen C5 growth summary into an HTML
// string the web UI can drop into the feed panel. Pure, dependency-free,
// deterministic given the same summary. No I/O, no network, no timers, no
// storage. Every user-derived string is HTML-escaped — agent ids and day
// labels can contain markup. Fail-closed: malformed summaries throw a clear
// Error, never partial garbage.
const isPlainObject = value => typeof value === "object" && value !== null && !Array.isArray(value);

const escapeHtml = value => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const checkSummary = summary => {
  if (!isPlainObject(summary)) throw new TypeError("renderGrowthFeed: summary must be a summary object");
  const { totals, activityByDay, topMentionedAgents, engagement, window, generatedAt } = summary;
  if (!isPlainObject(totals)) throw new TypeError("renderGrowthFeed: summary.totals must be an object");
  if (!Array.isArray(activityByDay)) throw new TypeError("renderGrowthFeed: summary.activityByDay must be an array");
  if (!Array.isArray(topMentionedAgents)) throw new TypeError("renderGrowthFeed: summary.topMentionedAgents must be an array");
  if (!isPlainObject(engagement)) throw new TypeError("renderGrowthFeed: summary.engagement must be an object");
  if (!isPlainObject(window)) throw new TypeError("renderGrowthFeed: summary.window must be a window object");
  if (typeof generatedAt !== "string" || !generatedAt.trim()) throw new TypeError("renderGrowthFeed: summary.generatedAt must be a timestamp string");
  return summary;
};

const windowLabel = window => {
  const since = window.since ? String(window.since).slice(0, 10) : null;
  const until = window.until ? String(window.until).slice(0, 10) : null;
  if (since && until) return `${since} → ${until}`;
  if (since) return `${since} → present`;
  if (until) return `up to ${until}`;
  return "all time";
};

const number = value => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("renderGrowthFeed: summary counts must be finite numbers");
  return value;
};

const bars = activityByDay => {
  if (activityByDay.length === 0) return `<p class="feed-empty">No activity in this window.</p>`;
  const max = Math.max(...activityByDay.map(d => number(d.count)));
  const rows = activityByDay.map(({ day, count }) => {
    const pct = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0;
    return `<div class="feed-bar-row"><span class="feed-bar-day">${escapeHtml(day)}</span>` +
      `<span class="feed-bar-track"><span class="feed-bar-fill" style="width:${pct}%"></span></span>` +
      `<span class="feed-bar-count">${number(count)}</span></div>`;
  });
  return `<div class="feed-bars" role="img" aria-label="Activity by day">${rows.join("")}</div>`;
};

const totalsList = totals => {
  const entries = Object.entries(totals).filter(([, count]) => number(count) > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (entries.length === 0) return `<p class="feed-empty">No events yet.</p>`;
  return `<ul class="feed-totals">${entries.map(([type, count]) =>
    `<li><span class="feed-total-type">${escapeHtml(type)}</span><span class="feed-total-count">${number(count)}</span></li>`).join("")}</ul>`;
};

const topAgents = topMentionedAgents => {
  if (topMentionedAgents.length === 0) return `<p class="feed-empty">No agent mentions in this window.</p>`;
  return `<ol class="feed-agents">${topMentionedAgents.slice(0, 10).map(({ agentId, mentions }) =>
    `<li><span class="feed-agent-id">${escapeHtml(agentId)}</span><span class="feed-agent-count">${number(mentions)}</span></li>`).join("")}</ol>`;
};

const engagementRow = engagement => {
  const { messages = 0, reactions = 0, pins = 0 } = engagement;
  return `<dl class="feed-engagement">` +
    `<div><dt>Messages</dt><dd>${number(messages)}</dd></div>` +
    `<div><dt>Reactions</dt><dd>${number(reactions)}</dd></div>` +
    `<div><dt>Pins</dt><dd>${number(pins)}</dd></div></dl>`;
};

export function renderGrowthFeed(summary) {
  const checked = checkSummary(summary);
  return `<section class="growth-feed" aria-label="Room activity feed">` +
    `<header class="feed-header"><h2>Room activity</h2>` +
    `<p class="feed-window">${escapeHtml(windowLabel(checked.window))} · generated ${escapeHtml(checked.generatedAt)}</p></header>` +
    `${engagementRow(checked.engagement)}` +
    `<h3>Events</h3>${totalsList(checked.totals)}` +
    `<h3>Activity by day</h3>${bars(checked.activityByDay)}` +
    `<h3>Top mentioned agents</h3>${topAgents(checked.topMentionedAgents)}` +
    `</section>`;
}
