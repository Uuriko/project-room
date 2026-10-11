// Unified approval inbox digest (WAVE-500 guild 10 — the unified approval inbox).
//
// This module REPLACES the evening tap-list digest: instead of a hand-edited
// markdown file, the digest is generated from live inbox state (cards) by the
// pure function renderDigest(). Nothing here does I/O and nothing reads the
// clock implicitly — pass `now` in options so output is deterministic.
//
// Card shape (all fields optional except where noted):
//   { id,            // card id — the footer tells the human to reply with it
//     kind,          // Money | Identity | Deploys | Permissions | Publish;
//                    // anything else (or missing) lands in Other
//     title,        // one-line summary; embedded newlines are collapsed
//     createdAtMs,  // epoch ms — drives age and "oldest unhandled"
//     expiresAtMs,  // epoch ms | null — drives the "expiring <24h" bucket
//                    // (cards already past deadline count and are marked overdue)
//     options,      // string[] — decision options, rendered "a / b"
//     ref }         // link ref for the card line; falls back to the kind's
//                    // card-list query when absent
//
// Options:
//   { forDate,   // Date | number | string — digest date in the title (UTC)
//     now,       // epoch ms — "now" for ages/expiry (default Date.now())
//     queryFor } // (query) => string — builds the link target for a card-list
//                //   query. query is one of "pending", "expiring", "money",
//                //   "identity", "deploys", "permissions", "publish", "other".
//                //   Default: q => `#inbox?query=${q}`. The room wires its real
//                //   routes here; every count in the digest links through it,
//                //   so each number is traceable back to a live card list.
const KINDS = ["Money", "Identity", "Deploys", "Permissions", "Publish", "Other"];
const KIND_SET = new Set(KINDS.map(k => k.toLowerCase()));
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EXPIRY_WINDOW_MS = DAY;

const canonicalKind = raw => {
  const k = String(raw ?? "").trim().toLowerCase();
  if (!KIND_SET.has(k) || k === "other") return "Other";
  return KINDS.find(name => name.toLowerCase() === k);
};
const kindQuery = kind => kind.toLowerCase();

// Collapse any embedded whitespace/newlines so every card stays one line.
const oneLine = value => String(value ?? "").replace(/\s+/g, " ").trim();

const formatAge = ms => {
  const minutes = Math.max(0, Math.floor(ms / MIN));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
};

const formatDateUTC = value => {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "undated" : d.toISOString().slice(0, 10);
};

// Card refs are system-generated card-list queries; keep the link plain so the
// digest stays greppable by downstream tooling.
const link = (text, href) => `[${text}](${href})`;

const normalizeCard = (card, now) => {
  const kind = canonicalKind(card.kind);
  const createdAtMs = Number.isFinite(card.createdAtMs) ? card.createdAtMs : null;
  const expiresAtMs = Number.isFinite(card.expiresAtMs) ? card.expiresAtMs : null;
  const options = Array.isArray(card.options)
    ? card.options.map(oneLine).filter(Boolean)
    : [];
  const id = oneLine(card.id) || null;
  return {
    id,
    kind,
    title: oneLine(card.title) || "(untitled card)",
    ageMs: createdAtMs === null ? null : now - createdAtMs,
    expiresAtMs,
    optionsText: options.join(" / ") || "—",
    ref: oneLine(card.ref) || null,
  };
};

const cardLink = (row, queryFor) => {
  const fallback = `${queryFor(kindQuery(row.kind))}${row.id ? `#${row.id}` : ""}`;
  const href = row.ref || fallback;
  const label = row.id || "open";
  return link(label, href);
};

const dueMarker = (row, now) => {
  if (row.expiresAtMs === null) return "";
  const remaining = row.expiresAtMs - now;
  if (remaining <= 0) return ` — overdue ${formatAge(-remaining)}`;
  if (remaining <= EXPIRY_WINDOW_MS) return ` — due ${formatAge(remaining)}`;
  return "";
};

export function renderDigest(cards, options = {}) {
  const { forDate, queryFor = q => `#inbox?query=${q}` } = options ?? {};
  const now = Number.isFinite(options?.now) ? options.now : Date.now();
  const list = Array.isArray(cards) ? cards : [];
  const rows = list
    .filter(c => c !== null && typeof c === "object")
    .map(c => normalizeCard(c, now));

  const byKind = new Map(KINDS.map(k => [k, []]));
  for (const row of rows) byKind.get(row.kind).push(row);
  for (const group of byKind.values()) {
    group.sort((a, b) => {
      const at = a.ageMs === null ? -Infinity : a.ageMs;
      const bt = b.ageMs === null ? -Infinity : b.ageMs;
      return bt - at; // oldest unhandled first
    });
  }

  const total = rows.length;
  const aged = rows.filter(r => r.ageMs !== null);
  const oldest = aged.length ? aged.reduce((a, b) => (b.ageMs > a.ageMs ? b : a)) : null;
  const expiring = rows.filter(r =>
    r.expiresAtMs !== null && r.expiresAtMs - now <= EXPIRY_WINDOW_MS);

  const lines = [];
  lines.push(`# Approval inbox digest — ${formatDateUTC(forDate ?? now)}`);
  lines.push("");
  const headerBits = [`[${total} pending](${queryFor("pending")})`];
  headerBits.push(oldest
    ? `oldest ${link(formatAge(oldest.ageMs), oldest.ref || queryFor(kindQuery(oldest.kind)))}`
    : "oldest unknown");
  headerBits.push(`[${expiring.length} expiring <24h](${queryFor("expiring")})`);
  lines.push(headerBits.join(" · "));
  lines.push("");

  if (total === 0) {
    lines.push("no pending decisions — the inbox is clear.");
  } else {
    for (const kind of KINDS) {
      const group = byKind.get(kind);
      if (group.length === 0) continue;
      lines.push(`## ${kind} — [${group.length}](${queryFor(kindQuery(kind))})`);
      lines.push("");
      for (const row of group) {
        lines.push(`- [${kindQuery(kind)}] ${row.title} — ${row.ageMs === null ? "age unknown" : formatAge(row.ageMs)} — ${row.optionsText}${dueMarker(row, now)} — ${cardLink(row, queryFor)}`);
      }
      lines.push("");
    }
  }

  lines.push("Generated from the approval inbox; reply with a card id to decide.");
  return lines.join("\n");
}
