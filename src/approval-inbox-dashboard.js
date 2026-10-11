// src/approval-inbox-dashboard.js
//
// Approval-inbox DASHBOARD — inbox health surface for the unified human approval
// inbox (WAVE-500 guild 10, slice 29/50).
//
// What it is: a dependency-free, dark-first HTML renderer for inbox health:
// pending-by-kind bars, pending-by-age buckets, oldest-pending callout,
// decided-today count, and median time-to-decision.
//
// TRACEABILITY RULE (teardown design): every number rendered is a link to the
// filtered card list producing it. Untraceable rows are dropped — no dead
// numbers. If `linkBase` is absent, counts are hidden entirely and a note
// explains what to pass.
//
// METRICS → VIEW CONTRACT (for slice 13, the metrics slice):
// If slice 13 ships its own metrics producer, it MUST return this shape:
// {
//   contract: "inbox-dashboard-metrics/1",
//   now: <ms epoch>,
//   linkBase: "<template containing {filter}>" | ((filter: string) => string) | null,
//   dataAvailable: boolean,          // false when the inbox API is unreachable;
//                                    // the dashboard must NOT render zero-claims
//   totalPending: { count, filter }, // filter "status=pending"
//   pendingByKind: [{ kind, count, filter }],  // filter "status=pending&kind=<kind>"
//   pendingByAge: [{ key, label, count, filter }], // filter "status=pending&age=<key>"
//   oldestPending: { id, kind, title, createdAt, ageMs, filter } | null,
//                                    // filter "status=pending&sort=oldest"
//   decidedToday: { count, filter }, // filter "status=decided&since=24h"
//   medianTimeToDecisionMs: number | null, // median over items decided in last 24h
// }
// `buildMetrics` below is the reference implementation of this contract: it
// computes the shape from raw inbox items, so the dashboard works standalone
// until slice 13 lands. Raw item shape: { id, kind, title, createdAt, status:
// "pending"|"decided", decidedAt?, decision? }.
//
// Kinds mirror server/approval-inbox-policy.mjs INBOX_KINDS (duplicated here so
// this client-side module stays dependency-free).

export const INBOX_KINDS = ["money", "identity", "deploy", "permission", "publish", "other"];

export const METRICS_CONTRACT = "inbox-dashboard-metrics/1";

export const AGE_BUCKETS = [
  { key: "under-1h", label: "under 1h", maxMs: 3600_000 },
  { key: "1h-6h", label: "1–6h", maxMs: 6 * 3600_000 },
  { key: "6h-24h", label: "6–24h", maxMs: 24 * 3600_000 },
  { key: "1d-3d", label: "1–3d", maxMs: 3 * 24 * 3600_000 },
  { key: "over-3d", label: "over 3d", maxMs: Number.POSITIVE_INFINITY },
];

export const KIND_COLORS = {
  money: "#e3b341",
  identity: "#58a6ff",
  deploy: "#3fb950",
  permission: "#bc8cff",
  publish: "#f778ba",
  other: "#8b949e",
};

const DAY_MS = 24 * 3600_000;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h}h ${rest}m` : `${h}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Reference implementation of the metrics contract: compute dashboard metrics
 * from raw inbox items. `linkBase` is a "{filter}" template string or a
 * function(filter) -> url; null means numbers cannot be traced (rows dropped).
 */
export function buildMetrics(items, { now = Date.now(), linkBase = null } = {}) {
  if (items == null) {
    return { contract: METRICS_CONTRACT, now, linkBase, dataAvailable: false };
  }
  const list = Array.isArray(items) ? items : [];
  const pending = list.filter((i) => i && i.status === "pending");
  const windowStart = now - DAY_MS;
  const decidedToday = list.filter(
    (i) => i && i.status === "decided" && Number.isFinite(i.decidedAt) && i.decidedAt >= windowStart && i.decidedAt <= now,
  );
  const decisionTimes = decidedToday
    .filter((i) => Number.isFinite(i.createdAt))
    .map((i) => i.decidedAt - i.createdAt)
    .filter((t) => t >= 0);

  const byKind = new Map(INBOX_KINDS.map((k) => [k, 0]));
  for (const i of pending) {
    if (INBOX_KINDS.includes(i.kind)) byKind.set(i.kind, byKind.get(i.kind) + 1);
    else byKind.set("other", (byKind.get("other") ?? 0) + 1);
  }

  const byAge = AGE_BUCKETS.map((b) => ({ ...b, count: 0 }));
  for (const i of pending) {
    const age = Number.isFinite(i.createdAt) ? now - i.createdAt : 0;
    const bucket = byAge.find((b) => age < b.maxMs) ?? byAge[byAge.length - 1];
    bucket.count += 1;
  }

  let oldest = null;
  for (const i of pending) {
    if (!Number.isFinite(i.createdAt)) continue;
    const ageMs = now - i.createdAt;
    if (!oldest || ageMs > oldest.ageMs) {
      oldest = { id: i.id, kind: i.kind, title: i.title ?? "", createdAt: i.createdAt, ageMs };
    }
  }

  return {
    contract: METRICS_CONTRACT,
    now,
    linkBase,
    dataAvailable: true,
    totalPending: { count: pending.length, filter: "status=pending" },
    pendingByKind: INBOX_KINDS.map((kind) => ({
      kind,
      count: byKind.get(kind) ?? 0,
      filter: `status=pending&kind=${kind}`,
    })),
    pendingByAge: byAge.map((b) => ({
      key: b.key,
      label: b.label,
      count: b.count,
      filter: `status=pending&age=${b.key}`,
    })),
    oldestPending: oldest ? { ...oldest, filter: "status=pending&sort=oldest" } : null,
    decidedToday: { count: decidedToday.length, filter: "status=decided&since=24h" },
    medianTimeToDecisionMs: median(decisionTimes),
  };
}

const CSS = `
.aid{--aid-bg:#0d1117;--aid-card:#161b22;--aid-border:#30363d;--aid-text:#e6edf3;
--aid-dim:#8b949e;--aid-accent:#58a6ff;background:var(--aid-bg);color:var(--aid-text);
border:1px solid var(--aid-border);border-radius:12px;padding:20px;
font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px}
.aid h2{margin:0 0 4px;font-size:18px}.aid .aid-sub{color:var(--aid-dim);font-size:13px}
.aid .aid-total{font-size:40px;font-weight:700;margin:12px 0 4px}
.aid .aid-total a{color:var(--aid-accent);text-decoration:none}
.aid .aid-total a:hover{text-decoration:underline}
.aid .aid-sec{margin-top:16px;font-size:13px;color:var(--aid-dim);text-transform:uppercase;letter-spacing:.06em}
.aid .aid-row{display:flex;align-items:center;gap:10px;margin:8px 0}
.aid .aid-kind{width:96px;font-size:14px}
.aid .aid-bar{flex:1;height:10px;background:var(--aid-card);border:1px solid var(--aid-border);border-radius:6px;overflow:hidden}
.aid .aid-fill{height:100%;border-radius:6px}
.aid .aid-n{font-variant-numeric:tabular-nums;font-weight:600}
.aid a.aid-n{color:var(--aid-accent);text-decoration:none}
.aid a.aid-n:hover{text-decoration:underline}
.aid .aid-stale{background:var(--aid-card);border:1px solid var(--aid-border);
border-left:3px solid #e3b341;border-radius:8px;padding:12px;margin-top:12px;font-size:14px}
.aid .aid-note{color:var(--aid-dim);font-size:14px;margin:12px 0}
.aid .aid-clear{font-size:16px;margin:16px 0 4px}
`;

function link(linkBase, filter, inner) {
  const url = typeof linkBase === "function" ? linkBase(filter) : String(linkBase).replace("{filter}", filter);
  return `<a class="aid-n" href="${esc(url)}">${inner}</a>`;
}

function stat(label, count, filter, linkBase) {
  return `<div class="aid-row"><span class="aid-kind">${esc(label)}</span>` +
    `<span class="aid-n">${link(linkBase, filter, esc(String(count)))}</span></div>`;
}

/**
 * Render the dashboard as an HTML string. Every number is a link to the
 * filtered card list producing it; rows without a traceable source are
 * dropped. Graceful states: data unavailable, missing linkBase, empty inbox.
 */
export function renderDashboard(metrics) {
  const m = metrics && typeof metrics === "object" ? metrics : {};
  if (m.dataAvailable === false) {
    return `<section class="aid"><style>${CSS}</style><h2>Approval inbox</h2>` +
      `<p class="aid-note">Inbox data unavailable — the metrics source did not respond. ` +
      `Nothing below is claimed about pending decisions.</p></section>`;
  }
  if (m.linkBase == null) {
    return `<section class="aid"><style>${CSS}</style><h2>Approval inbox</h2>` +
      `<p class="aid-note">Counts are hidden: every dashboard number must link to its ` +
      `filtered card list. Pass a <code>linkBase</code> to enable traceable numbers.</p></section>`;
  }
  const linkBase = m.linkBase;
  const total = m.totalPending?.count ?? 0;
  const decided = m.decidedToday?.count ?? 0;
  const medianMs = m.medianTimeToDecisionMs ?? null;

  if (total === 0 && decided === 0) {
    return `<section class="aid"><style>${CSS}</style><h2>Approval inbox</h2>` +
      `<p class="aid-sub">pending human decisions</p>` +
      `<p class="aid-clear">Inbox clear — no pending human decisions, none decided in the last day.</p></section>`;
  }

  const maxKind = Math.max(1, ...(m.pendingByKind ?? []).map((k) => k.count ?? 0));
  const kindRows = (m.pendingByKind ?? [])
    .filter((k) => (k.count ?? 0) > 0)
    .map((k) => {
      const pct = Math.round(((k.count ?? 0) / maxKind) * 100);
      const color = KIND_COLORS[k.kind] ?? KIND_COLORS.other;
      return `<div class="aid-row"><span class="aid-kind">${esc(k.kind)}</span>` +
        `<span class="aid-bar"><span class="aid-fill" style="width:${pct}%;background:${color}"></span></span>` +
        link(linkBase, k.filter, esc(String(k.count))) + `</div>`;
    })
    .join("");

  const ageRows = (m.pendingByAge ?? [])
    .filter((b) => (b.count ?? 0) > 0)
    .map((b) => stat(b.label, b.count, b.filter, linkBase))
    .join("");

  const oldest = m.oldestPending;
  const oldestHtml = oldest
    ? `<div class="aid-stale"><strong>Oldest pending:</strong> ${esc(oldest.kind)} — ` +
      `${esc(oldest.title || oldest.id)} · waiting ${esc(fmtDuration(oldest.ageMs))} ` +
      link(linkBase, oldest.filter, "view oldest-first →") + `</div>`
    : "";

  const decidedHtml = decided > 0 || medianMs != null
    ? `<div class="aid-sec">last 24h</div>` +
      stat("decided", decided, m.decidedToday.filter, linkBase) +
      (medianMs != null
        ? `<div class="aid-row"><span class="aid-kind">median decision</span>` +
          link(linkBase, m.decidedToday.filter, esc(`in ${fmtDuration(medianMs)}`)) + `</div>`
        : "")
    : "";

  return `<section class="aid"><style>${CSS}</style><h2>Approval inbox</h2>` +
    `<p class="aid-sub">pending human decisions — every number links to its cards</p>` +
    `<div class="aid-total">${link(linkBase, m.totalPending.filter, esc(String(total)))}</div>` +
    `<div class="aid-sub">pending</div>` +
    `<div class="aid-sec">by kind</div>${kindRows}` +
    `<div class="aid-sec">by age</div>${ageRows}` +
    oldestHtml + decidedHtml + `</section>`;
}
