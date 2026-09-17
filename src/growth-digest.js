// Track C slice C7 — Growth digest renderer.
//
// Renders a frozen C5 summary (from summarize()) into a human-readable
// digest, either plain text or markdown. Pure, dependency-free,
// deterministic given the same summary. No I/O, no network, no timers,
// no storage. Fail-closed: malformed summaries or unknown formats throw
// a clear Error — never partial garbage.

export const DIGEST_FORMATS = Object.freeze(["text", "markdown"]);
export const DIGEST_BAR_WIDTH = 24;

const isPlainObject = value =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const checkSummary = summary => {
  if (!isPlainObject(summary)) {
    throw new TypeError("renderDigest: summary must be a summary object");
  }
  const { totals, activityByDay, topMentionedAgents, engagement, window, generatedAt } = summary;
  if (!isPlainObject(totals)) throw new TypeError("renderDigest: summary.totals must be an object");
  if (!Array.isArray(activityByDay)) throw new TypeError("renderDigest: summary.activityByDay must be an array");
  if (!Array.isArray(topMentionedAgents)) throw new TypeError("renderDigest: summary.topMentionedAgents must be an array");
  if (!isPlainObject(engagement)) throw new TypeError("renderDigest: summary.engagement must be an object");
  if (!isPlainObject(window)) throw new TypeError("renderDigest: summary.window must be an object");
  if (typeof generatedAt !== "string" || generatedAt.trim() === "") {
    throw new TypeError("renderDigest: summary.generatedAt must be a timestamp string");
  }
  return summary;
};

const checkFormat = format => {
  if (format === undefined) return "text";
  if (!DIGEST_FORMATS.includes(format)) {
    throw new Error(`renderDigest: unknown format "${format}" (expected "text" or "markdown")`);
  }
  return format;
};

const windowLabel = window => {
  const since = window.since ? window.since.slice(0, 10) : null;
  const until = window.until ? window.until.slice(0, 10) : null;
  if (since && until) return `${since} → ${until}`;
  if (since) return `${since} → present`;
  if (until) return `up to ${until}`;
  return "all time";
};

// Proportional bar for a count against the max, scaled to DIGEST_BAR_WIDTH.
// Non-zero counts always get at least one block so sparse days stay visible.
const barFor = (count, max) => {
  if (max <= 0 || count <= 0) return "";
  const width = Math.max(1, Math.round((count / max) * DIGEST_BAR_WIDTH));
  return "█".repeat(width);
};

const renderText = summary => {
  const lines = [];
  lines.push("Growth digest");
  lines.push(`Window: ${windowLabel(summary.window)}`);
  lines.push(`Generated: ${summary.generatedAt}`);
  if (isEmpty(summary)) {
    lines.push("");
    lines.push("No activity in this window.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("Totals:");
  for (const [type, count] of Object.entries(summary.totals)) {
    if (count > 0) lines.push(`  ${type}: ${count}`);
  }
  lines.push("");
  lines.push("Daily activity:");
  const max = Math.max(...summary.activityByDay.map(entry => entry.count), 0);
  for (const { day, count } of summary.activityByDay) {
    lines.push(`  ${day}  ${barFor(count, max)} ${count}`);
  }
  lines.push("");
  lines.push("Top mentioned agents:");
  const top = summary.topMentionedAgents.slice(0, 10);
  if (top.length === 0) {
    lines.push("  none");
  } else {
    top.forEach(({ agentId, mentions }, index) => {
      lines.push(`  ${index + 1}. ${agentId} — ${mentions} mention${mentions === 1 ? "" : "s"}`);
    });
  }
  lines.push("");
  lines.push("Engagement:");
  const { messages, reactions, pins, mentions, mentionsPerMessage } = summary.engagement;
  lines.push(`  messages: ${messages}`);
  lines.push(`  reactions: ${reactions}`);
  lines.push(`  pins: ${pins}`);
  lines.push(`  mentions: ${mentions}`);
  lines.push(`  mentions per message: ${mentionsPerMessage === null ? "n/a" : `${Math.round(mentionsPerMessage * 100)}%`}`);
  return lines.join("\n");
};

const renderMarkdown = summary => {
  const lines = [];
  lines.push("# Growth digest");
  lines.push("");
  lines.push(`**Window:** ${windowLabel(summary.window)}`);
  lines.push(`**Generated:** ${summary.generatedAt}`);
  if (isEmpty(summary)) {
    lines.push("");
    lines.push("No activity in this window.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("## Totals");
  for (const [type, count] of Object.entries(summary.totals)) {
    if (count > 0) lines.push(`- \`${type}\`: ${count}`);
  }
  lines.push("");
  lines.push("## Daily activity");
  const max = Math.max(...summary.activityByDay.map(entry => entry.count), 0);
  for (const { day, count } of summary.activityByDay) {
    lines.push(`- ${day} \`${barFor(count, max)}\` ${count}`);
  }
  lines.push("");
  lines.push("## Top mentioned agents");
  const top = summary.topMentionedAgents.slice(0, 10);
  if (top.length === 0) {
    lines.push("None.");
  } else {
    top.forEach(({ agentId, mentions }, index) => {
      lines.push(`${index + 1}. **${agentId}** — ${mentions} mention${mentions === 1 ? "" : "s"}`);
    });
  }
  lines.push("");
  lines.push("## Engagement");
  const { messages, reactions, pins, mentions, mentionsPerMessage } = summary.engagement;
  lines.push(`- messages: ${messages}`);
  lines.push(`- reactions: ${reactions}`);
  lines.push(`- pins: ${pins}`);
  lines.push(`- mentions: ${mentions}`);
  lines.push(`- mentions per message: ${mentionsPerMessage === null ? "n/a" : `${Math.round(mentionsPerMessage * 100)}%`}`);
  return lines.join("\n");
};

const isEmpty = summary => Object.values(summary.totals).every(count => count === 0);

// Render a C5 summary into a digest string. `format` is "text" (default)
// or "markdown". Empty summaries render a short "no activity" digest.
// Malformed summaries and unknown formats throw — never partial garbage.
export function renderDigest(summary, { format } = {}) {
  const valid = checkSummary(summary);
  const chosen = checkFormat(format);
  return chosen === "markdown" ? renderMarkdown(valid) : renderText(valid);
}
