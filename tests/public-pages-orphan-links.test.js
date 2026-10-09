// Orphaned human-door pages (PRODUCT-200 HD-04).
//
// Contract:
//  - Every human-facing marketing page must be reachable from the human door:
//    one of /, /about, /offers, /join, /docs/agents, /compare/*, /receipts, or
//    the 404 page must link toward it (directly or through pages that link on).
//  - Internal links on the static human pages must resolve: a dead href is a
//    bug. Anchors must exist on their target page.
//
// The footers on the compare pages, the agent-docs pages, and the 404 page are
// the site-wide nav that keeps orphans (notably /offers, which once had zero
// inbound links) reachable. Served bytes are the contract: the server reads
// these files from disk verbatim.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(join(root, file), "utf8");

// Static human-door pages: URL path -> source file.
const COMPARE = [
  "project-room-vs-slack",
  "project-room-vs-discord",
  "agent-collaboration-tool",
  "multi-agent-workspace",
  "ai-agent-coordination",
  "project-room-vs-agent-room",
];
const AGENTS = [
  "claude-code", "codex", "cursor", "cline", "vscode", "aider",
  "openai-agents-sdk", "langgraph", "crewai",
];
const pageFiles = new Map([
  ["/", "index.html"],
  ["/about", "about.html"],
  ["/offers", "offers.html"],
  ["/join", "join.html"],
  ["/404", "404.html"],
  ["/operator.html", "operator.html"],
  ["/docs/agents", "docs/agents/index.html"],
  ...AGENTS.map(id => [`/docs/agents/${id}`, `docs/agents/${id}.html`]),
  ...COMPARE.map(name => [`/compare/${name}`, `compare/${name}.html`]),
]);

// Human-facing dynamic routes (valid link targets, not link sources here).
const dynamicRoutes = new Set([
  "/receipts", "/demo", "/terms", "/privacy", "/subprocessors",
  "/acceptable-use", "/report", "/legal",
  "/llms.txt", "/kits.txt", "/.well-known/agent.json",
]);

// Server canonicalization (server/http.mjs): the .html forms redirect to the
// extensionless canonical URLs.
const canonical = path =>
  path === "/index.html" ? "/" : path === "/about.html" ? "/about" : path === "/offers.html" ? "/offers" : path;

const fileToPath = new Map([...pageFiles].map(([path, file]) => [file, path]));

const hrefRe = /href\s*=\s*"([^"]+)"/g;

function linksFrom(srcFile, html) {
  const out = [];
  for (const match of html.matchAll(hrefRe)) {
    const raw = match[1];
    if (/^(https?:|mailto:|tel:|data:|javascript:)/i.test(raw)) continue;
    if (raw.startsWith("{{")) continue; // join.html {{ASSET_BASE}} template prefix
    const query = raw.indexOf("?");
    const noQuery = query === -1 ? raw : raw.slice(0, query);
    const hash = noQuery.indexOf("#");
    const pathPart = hash === -1 ? noQuery : noQuery.slice(0, hash);
    const frag = hash === -1 ? "" : noQuery.slice(hash + 1);
    if (pathPart === "") {
      if (frag) out.push({ target: fileToPath.get(srcFile) ?? srcFile, frag, from: srcFile });
      continue;
    }
    let target;
    if (pathPart.startsWith("/")) {
      target = pathPart.replace(/\/+$/, "") || "/";
    } else {
      target = "/" + normalize(join(dirname(srcFile), pathPart)).replace(/\\/g, "/");
    }
    out.push({ target: canonical(target), frag, from: srcFile });
  }
  return out;
}

function resolveTarget(path) {
  if (path.startsWith("/api/")) return true; // API links are not pages
  if (pageFiles.has(path)) return true;
  if (dynamicRoutes.has(path)) return true;
  if (existsSync(join(root, path.slice(1)))) return true; // static asset on disk
  if (existsSync(join(root, path.slice(1) + ".html"))) return true; // extensionless static page
  if (path.endsWith("/index.html") && existsSync(join(root, path.slice(1)))) return true;
  return false;
}

function anchorExists(file, frag) {
  if (!frag) return true;
  const html = read(file);
  return html.includes(`id="${frag}"`) || html.includes(`name="${frag}"`);
}

test("no dead internal links on the static human-door pages", () => {
  const dead = [];
  const badAnchors = [];
  for (const [, file] of pageFiles) {
    const html = read(file).replaceAll("{{ASSET_BASE}}", "");
    for (const link of linksFrom(file, html)) {
      if (!resolveTarget(link.target)) {
        dead.push(`${file} -> ${link.target}`);
        continue;
      }
      const targetFile = pageFiles.get(link.target);
      if (link.frag && targetFile && !anchorExists(targetFile, link.frag)) {
        badAnchors.push(`${file} -> ${link.target}#${link.frag}`);
      }
    }
  }
  assert.deepEqual(dead, [], `dead internal links:\n${dead.join("\n")}`);
  assert.deepEqual(badAnchors, [], `broken anchors:\n${badAnchors.join("\n")}`);
});

test("every marketing page has inbound links from the site nav", () => {
  // Inbound edges computed only from the pages whose footers this lane owns
  // (compare pages, agent-docs pages, 404) plus the entry pages themselves,
  // so sibling lanes editing their own pages cannot break this contract.
  const controlled = new Set([
    "404.html",
    "docs/agents/index.html",
    ...AGENTS.map(id => `docs/agents/${id}.html`),
    ...COMPARE.map(name => `compare/${name}.html`),
  ]);
  const inbound = new Map();
  for (const [, file] of pageFiles) {
    if (!controlled.has(file)) continue;
    const html = read(file);
    for (const link of linksFrom(file, html)) {
      if (!pageFiles.has(link.target) && !dynamicRoutes.has(link.target)) continue;
      if (!inbound.has(link.target)) inbound.set(link.target, new Set());
      inbound.get(link.target).add(file);
    }
  }
  for (const must of ["/offers", "/about", "/docs/agents", "/receipts", ...COMPARE.map(n => `/compare/${n}`)]) {
    const from = [...(inbound.get(must) ?? [])];
    assert.ok(from.length > 0, `${must} has no inbound links from the site nav`);
  }
});

test("404 page is a working door: links the key human pages", () => {
  const html = read("404.html");
  for (const path of ["/", "/about", "/offers", "/docs/agents", "/receipts"]) {
    assert.ok(html.includes(`href="${path}"`), `404.html should link ${path}`);
  }
  assert.ok(
    COMPARE.some(name => html.includes(`href="/compare/${name}"`)),
    "404.html should link at least one comparison page",
  );
});

test("compare footers carry site nav (no compare island)", () => {
  for (const name of COMPARE) {
    const html = read(`compare/${name}.html`);
    for (const path of ["/", "/about", "/offers", "/docs/agents"]) {
      assert.ok(html.includes(`href="${path}"`), `compare/${name}.html should link ${path}`);
    }
  }
});

test("agent-docs footers carry site nav", () => {
  for (const file of ["docs/agents/index.html", ...AGENTS.map(id => `docs/agents/${id}.html`)]) {
    const html = read(file);
    for (const path of ["/", "/about", "/offers"]) {
      assert.ok(html.includes(`href="${path}"`), `${file} should link ${path}`);
    }
  }
});
