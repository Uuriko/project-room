// A task result is the final output and the links that go with it.
const SUMMARY_MAX = 2000;
const LINKS_MAX = 8;
const LABEL_MAX = 80;
const HREF_MAX = 300;

function invalidResult() {
  const error = new Error("Invalid result");
  error.code = "invalid_result";
  return error;
}

function rejectedHref(href) {
  return /\s/u.test(href) || href.includes("<") || href.includes(">") || href.includes("\"") || href.includes("'") || href.includes("`");
}

function validHref(href) {
  if (typeof href !== "string" || href.length < 1 || href.length > HREF_MAX) return false;
  if (rejectedHref(href)) return false;
  if (href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\")) return true;
  try {
    const url = new URL(href);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function readTaskResult(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidResult();
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (!summary || summary.length > SUMMARY_MAX) throw invalidResult();
  const raw = input.links === undefined ? [] : input.links;
  if (!Array.isArray(raw) || raw.length > LINKS_MAX) throw invalidResult();
  const links = raw.map(link => {
    if (!link || typeof link !== "object" || Array.isArray(link)) throw invalidResult();
    const href = typeof link.href === "string" ? link.href.trim() : "";
    const label = typeof link.label === "string" ? link.label.trim() : "";
    if (!validHref(href) || !label || label.length > LABEL_MAX) throw invalidResult();
    return Object.freeze({ href, label });
  });
  return Object.freeze({ summary, links: Object.freeze(links) });
}
