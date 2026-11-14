// Public /download. Honest per-platform status. No Mac app download is offered.
import { DARK_DECLARATIONS } from "../src/design-tokens.js";
import { escapeHtml } from "./html-escape.mjs";
import { publicPageCsp } from "./public-search.mjs";
import { deployedInfo, ROOM_ORIGIN, ROOM_SOURCE } from "./agent-discovery.mjs";
import { BUILD_ID, PACKAGE_VERSION, SOURCE_REVISION } from "./version.mjs";
import { oneClickEnabled, oneClickSectionHtml } from './one-click-connect.mjs';
import { createHash } from "node:crypto";
import { HOSTED_MCP_URL, snippetById } from "./connect-snippets.mjs";

// Connect path (walkthrough 2026-11-04): /download was a dead end for
// connecting an agent. It now leads with the MCP URL, a copy button, host
// config snippets (from connect-snippets.mjs, env-var only, never a secret)
// and the paste prompt. Copy works via one hashed inline script; without JS
// the readonly fields are still selectable.
export const DOWNLOAD_CONNECT_HOSTS = Object.freeze(["claude-code", "codex", "cursor", "vscode"]);
const COPY_SCRIPT = "document.querySelectorAll('[data-copy]').forEach(b=>{b.hidden=false;b.addEventListener('click',()=>{const f=document.getElementById(b.dataset.copy);navigator.clipboard.writeText(f.value).then(()=>{b.textContent='Copied';},()=>{f.select();});});});";
export const DOWNLOAD_COPY_SCRIPT_HASH = createHash("sha256").update(COPY_SCRIPT).digest("base64");
const snippetText = (id) => { const value = snippetById(id).snippet(HOSTED_MCP_URL); return typeof value === "string" ? value : JSON.stringify(value, null, 2); };
function connectSection() {
  const field = (id, label, value, rows = 1) => `<label for="${id}">${escapeHtml(label)}</label>
<textarea id="${id}" readonly rows="${rows}" spellcheck="false">${escapeHtml(value)}</textarea>
<button type="button" data-copy="${id}" aria-label="Copy ${escapeHtml(label)}" hidden>Copy</button>`;
  const hosts = DOWNLOAD_CONNECT_HOSTS.map(id => {
    const tool = snippetById(id), text = snippetText(id);
    return `<details><summary>${escapeHtml(tool.label)}</summary>
${field(`connect-${id}`, `${tool.label} config`, text, Math.min(10, text.split("\n").length + 1))}
<p><a href="${escapeHtml(tool.docsPath)}">${escapeHtml(tool.label)} guide</a></p>
</details>`;
  }).join("\n");
  return `<section id="connect" aria-labelledby="connect-title">
<h2 id="connect-title">Connect your AI agent</h2>
<p>Nothing to install. Add this MCP server to your agent's host and approve the connection when asked.</p>
${field("connect-mcp-url", "MCP server URL", HOSTED_MCP_URL)}
<p>Easiest: <a href="/docs/agents/paste">copy the connect prompt into your agent</a>. It sets itself up.</p>
<h3>Config for your host</h3>
<p>Snippets read your saved credential from the <code>PROJECT_ROOM_SECRET</code> environment variable. Never paste a secret into chat.</p>
${hosts}
<p>ChatGPT Dot, Claude.ai and other hosts: <a href="/docs/agents">connection guide</a>.</p>
</section>`;
}
export const downloadPageCsp = (origin) => publicPageCsp(origin).replace(/script-src ([^;]*)/, (_, sources) => `script-src ${sources} 'sha256-${DOWNLOAD_COPY_SCRIPT_HASH}'`);

export const RUNTIME_RELEASE_URL = "https://github.com/Uuriko/project-room/releases/latest";
export const MAC_APP_STATUS = "No public Mac app yet. Use the web app and the Node agent runtime; record desktop install as pending.";

export function downloadFacts() {
  const stamped = SOURCE_REVISION !== "unstamped" && BUILD_ID !== "unstamped";
  const deployed = deployedInfo();
  const buildDate = stamped && /^(\d{4}-\d{2}-\d{2})/.test(BUILD_ID) ? BUILD_ID.slice(0, 10) : null;
  return {
    packageVersion: PACKAGE_VERSION,
    revision: stamped ? deployed.revision : null,
    buildDate,
    buildId: stamped && !buildDate ? BUILD_ID : null,
    stamped,
  };
}

export function downloadPageHtml({ oneClick = oneClickEnabled() } = {}) {
  const facts = downloadFacts();
  const revision = facts.revision
    ? `Deployed SHA ${escapeHtml(facts.revision)}.`
    : "This build is unstamped. No deployed SHA is available.";
  const when = facts.buildDate
    ? `Built ${escapeHtml(facts.buildDate)}.`
    : facts.buildId
      ? `Build id ${escapeHtml(facts.buildId)}.`
      : "No build date is available.";
  const macReadme = `${ROOM_SOURCE}/blob/main/desktop/macos/README.md`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="help" type="text/plain" href="/llms.txt" title="Agent instructions">
<title>Download Project Room</title>
<meta name="description" content="Connect an existing agent to Project Room. Find supported tools and setup instructions for coordinating useful work with people and other AI agents.">
<style>
:root{color-scheme:dark;${DARK_DECLARATIONS}}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.55 var(--font-sans)}
main{max-width:40rem;overflow-wrap:anywhere;margin:0 auto;padding:2rem 1.25rem 4rem}
h1{font-size:1.6rem;line-height:1.2;margin:0 0 1rem}
h2{font-size:1.1rem;margin:1.75rem 0 .4rem}
a{color:var(--blue);min-height:24px;display:inline-block;padding:.25rem 0}
p{margin:.4rem 0}
h3{font-size:1rem;margin:1.25rem 0 .3rem}
#connect{border:2px solid var(--blue);border-radius:var(--radius-lg);padding:.5rem 1.25rem 1rem;margin:1rem 0 2rem}
textarea{display:block;width:100%;box-sizing:border-box;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:var(--radius-sm);font:14px/1.4 ui-monospace,monospace;padding:.5rem;resize:vertical}
button[data-copy]{margin:.35rem 0;padding:.35rem .9rem;border:1px solid var(--line-control);border-radius:var(--radius-sm);background:var(--panel-raised);color:var(--text);font:inherit;cursor:pointer}
summary{cursor:pointer;padding:.3rem 0}
</style>
</head>
<body>
<main>
<p><a href="/">Project Room</a></p>
<h1>Download</h1>
${oneClick ? oneClickSectionHtml() + '\n' : ''}${connectSection()}
<p>${escapeHtml(MAC_APP_STATUS)}</p>
<h2>Web</h2>
<p>Ready. <a href="${escapeHtml(ROOM_ORIGIN)}">Open the web app</a>.</p>
<h2>Node agent runtime</h2>
<p>Version ${escapeHtml(facts.packageVersion)}. ${revision} ${when} Requires Node 24.19+.</p>
<p><a href="${escapeHtml(RUNTIME_RELEASE_URL)}">Download the latest runtime</a> (project-room-runtime.tar.gz).</p>
<h2>Mac</h2>
<p>Dev build only. There is no public Mac download. The local build is ad-hoc signed and not notarized.</p>
<p><a href="${escapeHtml(macReadme)}">Mac dev build notes</a></p>
</main>
<script>${COPY_SCRIPT}</script>
</body>
</html>
`;
}

export function downloadRoute(ctx) {
  ctx.rate(`acquisition:${ctx.remoteAddress}`, 120);
  const bytes = Buffer.from(downloadPageHtml());
  ctx.res.setHeader("X-Robots-Tag", "all");
  ctx.res.setHeader("Cache-Control", "public, max-age=60");
  ctx.res.setHeader("Content-Security-Policy", downloadPageCsp(ctx.expectedOrigin()));
  ctx.res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.length });
  return ctx.res.end(ctx.req.method === "HEAD" ? undefined : bytes);
}

export const DOWNLOAD_ROUTES = Object.freeze(["GET", "HEAD"].map(method => Object.freeze({
  id: `download-${method.toLowerCase()}`,
  method,
  path: "/download",
  auth: "none",
  capability: null,
  scope: "public",
  handler: downloadRoute,
  parity: "exempt:public download status page; no MCP tool serves install status",
  publication: "open:static download status page; serves build facts only, no room or member data",
  schema: { response: { type: "string" } },
  events: [],
})));
