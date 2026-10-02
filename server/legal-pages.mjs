// Public legal pages rendered from docs/legal. The worker bundle falls back
// to the embedded copy when the files are not on disk.
import { readFileSync } from "node:fs";
import { EMBEDDED_LEGAL } from "./legal-documents.mjs";
import { TERMS_VERSION } from "./legal-store.mjs";

export const LEGAL_CACHE_CONTROL = "public, max-age=3600";
export const LEGAL_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const REPORT_PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const LEGAL_SITEMAP_PATHS = Object.freeze(["/terms", "/privacy", "/subprocessors", "/acceptable-use", "/legal"]);
export const LEGAL_FOOTER_LINKS = `<a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/subprocessors">Subprocessors</a> · <a href="/acceptable-use">Acceptable use</a> · <a href="/report">Report</a> · <a href="mailto:potter@trydemigod.com">Abuse</a>`;
export const ABUSE_EMAIL = "potter@trydemigod.com";

const PAGE_FILES = Object.freeze({
  "/terms": "terms.md",
  "/privacy": "privacy.md",
  "/acceptable-use": "acceptable-use.md",
});

export function reportHref(kind, target) {
  return `/report?kind=${encodeURIComponent(kind)}&target=${encodeURIComponent(target)}`;
}

export function readLegalFile(name) {
  try {
    return readFileSync(new URL(`../docs/legal/${name}`, import.meta.url), "utf8");
  } catch {
    const text = EMBEDDED_LEGAL[name];
    if (typeof text !== "string") throw new Error(`Missing legal document ${name}`);
    return text;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function inline(text) {
  return escapeHtml(text).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]+|mailto:[^\s)]+)\)/g, `<a href="$2">$1</a>`);
}

export function renderMarkdown(markdown) {
  const html = [];
  let list = false;
  const closeList = () => { if (list) { html.push("</ul>"); list = false; } };
  for (const line of String(markdown).replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) { closeList(); continue; }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (line.startsWith("- ")) {
      if (!list) { html.push("<ul>"); list = true; }
      html.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return html.join("");
}

function pageHtml({ title, main }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:1rem/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1c1b22}a{color:#33339a}footer{margin-top:2rem;font-size:.875rem}</style>
</head><body>
<main>${main}</main>
<footer>${LEGAL_FOOTER_LINKS}</footer>
</body></html>`;
}

function subprocessorsHtml() {
  const rows = JSON.parse(readLegalFile("subprocessors.json"));
  const items = rows.map(row => `<article><h2>${escapeHtml(row.name)}</h2><p>${escapeHtml(row.purpose)}</p><p>Region: ${escapeHtml(row.region)}</p></article>`).join("");
  return pageHtml({
    title: "Subprocessors",
    main: `<h1>Subprocessors</h1><p>Version: ${escapeHtml(TERMS_VERSION)}</p><p>These companies process data for Project Room at room.trydemigod.com. Demigod Labs, Inc. operates the service.</p>${items}`,
  });
}

function indexHtml() {
  return pageHtml({
    title: "Legal",
    main: `<h1>Legal</h1><p>Version: ${escapeHtml(TERMS_VERSION)}. Project Room at room.trydemigod.com is operated by Demigod Labs, Inc.</p>
<ul>
<li><a href="/terms">Terms of Service</a></li>
<li><a href="/privacy">Privacy Policy</a></li>
<li><a href="/subprocessors">Subprocessors</a></li>
<li><a href="/acceptable-use">Acceptable use</a></li>
</ul>`,
  });
}

export function legalPageHtml(pathname) {
  if (pathname === "/legal") return indexHtml();
  if (pathname === "/subprocessors") return subprocessorsHtml();
  const file = PAGE_FILES[pathname];
  if (!file) return null;
  const markdown = readLegalFile(file);
  const title = /^# (.+)$/m.exec(markdown)?.[1] ?? "Project Room";
  return pageHtml({ title, main: renderMarkdown(markdown) });
}

export function securityTxt() {
  return `Contact: mailto:${ABUSE_EMAIL}\nExpires: 2027-10-02T00:00:00.000Z\nPreferred-Languages: en\nCanonical: https://room.trydemigod.com/.well-known/security.txt\nPolicy: https://room.trydemigod.com/acceptable-use\n`;
}

export function reportPageHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Report</title>
<style>body{font:1rem/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}textarea,input,select{width:100%;max-width:36rem}</style>
</head><body>
<main>
<h1>Report</h1>
<p>Report a public room, receipt, or agent card. The server stores a hash of your IP address, not the address.</p>
<p>If this page cannot run the check, email <a href="mailto:${ABUSE_EMAIL}">${ABUSE_EMAIL}</a>.</p>
<form>
<label>What is it? <select name="kind"><option value="room">Room</option><option value="receipt">Receipt</option><option value="agent">Agent</option></select></label>
<label>Id <input name="target" required maxlength="128"></label>
<label>What happened? <textarea name="body" required maxlength="1000" rows="6"></textarea></label>
<label>Email (optional) <input name="email" type="email" maxlength="254"></label>
<button type="submit">Send report</button>
</form>
<p data-status role="status"></p>
</main>
<footer>${LEGAL_FOOTER_LINKS}</footer>
<script>
const params = new URLSearchParams(location.search);
const form = document.querySelector("form");
if (params.get("kind")) form.kind.value = params.get("kind");
if (params.get("target")) form.target.value = params.get("target");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("[data-status]");
  status.textContent = "Checking…";
  const kind = form.kind.value;
  const target = form.target.value.trim();
  const reportBody = form.body.value;
  const email = form.email.value.trim();
  const challenge = await fetch("/api/reports/public/challenge").then(response => response.json());
  const prefix = "0".repeat(challenge.bits / 4);
  const encoder = new TextEncoder();
  let nonce = "";
  for (let i = 0; i < 200000; i++) {
    nonce = "n" + i.toString(36);
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(challenge.bucket + ":" + kind + ":" + target + ":" + nonce));
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (hex.startsWith(prefix)) break;
  }
  const payload = { kind, target, body: reportBody, bucket: challenge.bucket, nonce };
  if (email) payload.email = email;
  const response = await fetch("/api/reports/public", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const json = await response.json().catch(() => ({}));
  status.textContent = response.ok ? "Report received. Thank you." : (json.error && json.error.message) || "Could not send the report.";
});
</script>
</body></html>`;
}
