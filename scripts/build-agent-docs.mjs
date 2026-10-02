// Build the static /docs/agents pages from docs/agents/*.md and the connect table.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectSnippets, HOSTED_MCP_URL, WORK_LOOP, renderedSnippet } from "../server/connect-snippets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://room.trydemigod.com";

const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function inline(text) {
  const parts = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    parts.push(escape(text.slice(last, match.index)));
    if (match[1] !== undefined) {
      const href = match[2].startsWith("../../examples/") ? match[2].slice(5) : match[2];
      const safe = /^(https?:|\/)/.test(href) ? href : href.endsWith(".md") ? "/docs/agents/" + href.replace(/\.md$/, "") : null;
      if (!safe) throw new Error("Unsafe link in agent docs: " + href);
      const target = safe.endsWith("/index") ? safe.slice(0, -"/index".length) : safe;
      parts.push(`<a href="${escape(target)}">${escape(match[1])}</a>`);
    } else parts.push(`<code>${escape(match[3])}</code>`);
    last = match.index + match[0].length;
  }
  parts.push(escape(text.slice(last)));
  return parts.join("");
}

export function renderMarkdown(markdown) {
  const blocks = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flush();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) { body.push(lines[i]); i += 1; }
      blocks.push(`<pre><code>${escape(body.join("\n"))}</code></pre>`);
      i += 1;
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (line.startsWith("- ")) {
      flush();
      const items = [];
      while (i < lines.length && lines[i].startsWith("- ")) { items.push(`<li>${inline(lines[i].slice(2))}</li>`); i += 1; }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\d+\. /, ""))}</li>`); i += 1; }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (line.trim() === "") { flush(); i += 1; continue; }
    paragraph.push(line.trim());
    i += 1;
  }
  flush();
  return blocks.join("\n");
}

function sections(markdown) {
  const found = [];
  const chunks = markdown.split(/^## /m).slice(1);
  for (const chunk of chunks) {
    const [title, ...rest] = chunk.split("\n");
    found.push({ title: title.trim(), text: rest.join("\n").replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim() });
  }
  return found;
}

function howTo(name, steps) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "HowTo",
    name,
    step: steps.map((step, index) => ({ "@type": "HowToStep", position: index + 1, name: step.title, text: step.text })),
  }).replaceAll("<", "\\u003c");
}

const style = `:root{color-scheme:dark;--bg:#202127;--text:#eeedf1;--muted:#aaaab7;--blue:#a9b9ff;--line:#393b45;--font:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.6 var(--font)}
main{max-width:720px;margin:auto;padding:40px 20px}
h1{font-size:clamp(28px,6vw,42px);line-height:1.15;letter-spacing:-.04em}
h2{font-size:23px;margin-top:32px}
p,li{color:var(--muted)}
h1,h2{color:var(--text)}
a{color:var(--blue)}
pre{overflow:auto;padding:12px 16px;background:#191a20;border:1px solid var(--line);border-radius:.45rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
footer{margin-top:40px;border-top:1px solid var(--line);padding-top:16px;color:var(--muted)}
`;

function page({ title, description, path, body, steps }) {
  const canonical = ORIGIN + path;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${style}</style>
<script type="application/ld+json">${howTo(title, steps)}</script>
</head><body><main>
${body}
<footer><a href="/docs/agents">All agents</a> · <a href="https://github.com/Uuriko/project-room">Source</a></footer>
</main></body></html>
`;
}

export function agentPages(dir = join(root, "docs", "agents")) {
  const pages = new Map();
  const indexMd = readFileSync(join(dir, "index.md"), "utf8");
  for (const tool of connectSnippets) {
    if (!indexMd.includes(`(${tool.id}.md)`)) throw new Error("docs/agents/index.md does not link to " + tool.id);
    const markdown = readFileSync(join(dir, tool.id + ".md"), "utf8");
    if (!markdown.includes(tool.command)) throw new Error(tool.id + " page does not include its command");
    const snippet = renderedSnippet(tool, HOSTED_MCP_URL);
    if (/pri_[A-Za-z0-9_-]{8,}/.test(snippet) || /pri_[A-Za-z0-9_-]{8,}/.test(markdown)) throw new Error(tool.id + " snippet contains a secret");
    const body = renderMarkdown(markdown) + `\n<h2>Config</h2>\n<pre><code>${escape(snippet.trimEnd())}</code></pre>`;
    const steps = sections(markdown);
    steps.push({ title: "Config", text: snippet.replace(/\s+/g, " ").trim() });
    pages.set(tool.htmlFile, page({
      title: `Connect ${tool.label}`,
      description: `Connect ${tool.label} to Project Room with one command. The config names an environment variable and does not contain a secret.`,
      path: tool.docsPath,
      body,
      steps,
    }));
  }
  const indexBody = renderMarkdown(indexMd) + "<ul>" + connectSnippets.map(tool => `<li><a href="${tool.docsPath}">${escape(tool.label)}</a> — <code>${escape(tool.command)}</code></li>`).join("") + "</ul>";
  pages.set("docs/agents/index.html", page({
    title: "Connect your agent",
    description: "One command connects Claude Code, Codex, Cursor, Cline, VS Code, Aider, or a framework agent to the shared room.",
    path: "/docs/agents",
    body: indexBody,
    steps: [{ title: "Pick a tool", text: connectSnippets.map(tool => tool.label).join(", ") }, ...WORK_LOOP.map((text, index) => ({ title: "Work loop " + (index + 1), text }))],
  }));
  return pages;
}

export function writeAgentPages() {
  const pages = agentPages();
  for (const [file, html] of pages) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
  }
  return pages;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const pages = writeAgentPages();
  console.log(`Wrote ${pages.size} agent docs pages.`);
}
