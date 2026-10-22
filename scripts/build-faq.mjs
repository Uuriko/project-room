// Build the static /faq page from docs/FAQ.md (#3976).
//
// In the spirit of scripts/build-agent-docs.mjs: the committed source is
// the Markdown, the HTML is generated build output (decision #36) —
// faq.html is registered in server/public-assets.mjs's generated set, is
// never committed, and the Cloudflare build renders it before building
// assets (cloudflare/wrangler.jsonc). The page is SSR HTML: the rendered
// questions and answers are in the document itself, and a FAQPage JSON-LD
// block is emitted from the same Q&A headings so crawlers and answer
// engines read exactly what a human reader sees.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeBlock } from "./build-agent-docs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://room.trydemigod.com";
export const FAQ_PAGE = Object.freeze({ docsPath: "/faq", htmlFile: "faq.html" });

const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function inline(text) {
  const parts = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    parts.push(escape(text.slice(last, match.index)));
    if (match[1] !== undefined) {
      const href = match[2];
      const safe = /^(https?:|\/|#)/.test(href) ? href : href.endsWith(".md") ? "/" + href.replace(/\.md$/, "") : null;
      if (!safe) throw new Error("Unsafe link in FAQ: " + href);
      parts.push(`<a href="${escape(safe)}">${escape(match[1])}</a>`);
    } else if (match[3] !== undefined) parts.push(`<code>${escape(match[3])}</code>`);
    else parts.push(`<strong>${escape(match[4])}</strong>`);
    last = match.index + match[0].length;
  }
  parts.push(escape(text.slice(last)));
  return parts.join("");
}

function plainText(text) {
  return text
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/^-\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Every ### heading is a question; its answer is everything up to the
// next ### or ## heading, as plain text for the FAQPage JSON-LD.
export function faqQuestions(markdown) {
  const questions = [];
  const chunks = markdown.split(/^### /m).slice(1);
  for (const chunk of chunks) {
    const [name, ...rest] = chunk.split("\n");
    const body = rest.join("\n").split(/^## /m)[0];
    questions.push({ name: plainText(name), text: plainText(body) });
  }
  return questions;
}

export function renderFaqMarkdown(markdown) {
  const blocks = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let lastHeading = "";
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
      blocks.push(codeBlock(body.join("\n"), lastHeading || "Code example"));
      i += 1;
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      lastHeading = heading[2];
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (line.startsWith("- ")) {
      flush();
      const items = [];
      while (i < lines.length) {
        if (lines[i].startsWith("- ")) { items.push(lines[i].slice(2)); i += 1; continue; }
        // A wrapped continuation of the current item is indented.
        if (items.length && /^(\s{2,}|\t)/.test(lines[i]) && lines[i].trim() !== "") {
          items[items.length - 1] += " " + lines[i].trim();
          i += 1;
          continue;
        }
        break;
      }
      blocks.push(`<ul>${items.map(item => `<li>${inline(item)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(lines[i].replace(/^\d+\. /, "")); i += 1; }
      blocks.push(`<ol>${items.map(item => `<li>${inline(item)}</li>`).join("")}</ol>`);
      continue;
    }
    if (line.trim() === "") { flush(); i += 1; continue; }
    paragraph.push(line.trim());
    i += 1;
  }
  flush();
  return blocks.join("\n");
}

function faqPageJsonLd(questions) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: questions.map(question => ({
      "@type": "Question",
      name: question.name,
      acceptedAnswer: { "@type": "Answer", text: question.text },
    })),
  }).replaceAll("<", "\\u003c");
}

const style = `:root{color-scheme:dark;--bg:#202127;--text:#eeedf1;--muted:#aaaab7;--blue:#a9b9ff;--line:#393b45;--font:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.6 var(--font)}
main{max-width:720px;margin:auto;padding:40px 20px;overflow-wrap:anywhere}
h1{font-size:clamp(28px,6vw,42px);line-height:1.15;letter-spacing:-.04em}
h2{font-size:23px;margin-top:32px}
h3{font-size:19px;margin-top:24px}
p,li{color:var(--muted)}
h1,h2,h3{color:var(--text)}
a{color:var(--blue)}
pre{box-sizing:border-box;max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;padding:12px 16px;background:#191a20;border:1px solid var(--line);border-radius:.45rem}
pre:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
:not(pre)>code{overflow-wrap:anywhere}
footer{margin-top:40px;border-top:1px solid var(--line);padding-top:16px;color:var(--muted)}
`;

export function faqPageHtml(markdown = readFileSync(join(root, "docs", "FAQ.md"), "utf8")) {
  const title = "Project Room FAQ";
  const description = "Answers about Project Room: rooms, agents, work items and bounties, privacy and security, and troubleshooting.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<link rel="canonical" href="${ORIGIN}${FAQ_PAGE.docsPath}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${style}</style>
<script type="application/ld+json">${faqPageJsonLd(faqQuestions(markdown))}</script>
</head><body><main>
${renderFaqMarkdown(markdown)}
<footer><a href="/">Home</a> · <a href="/about">About</a> · <a href="/faq">FAQ</a> · <a href="/offers">Open offers</a> · <a href="/docs/agents">Connect your agent</a> · <a href="https://github.com/Uuriko/project-room">Source</a></footer>
</main></body></html>
`;
}

export function writeFaqPage() {
  const html = faqPageHtml();
  writeFileSync(join(root, FAQ_PAGE.htmlFile), html);
  return new Map([[FAQ_PAGE.htmlFile, html]]);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  writeFaqPage();
  console.log("Wrote faq.html from docs/FAQ.md.");
}
