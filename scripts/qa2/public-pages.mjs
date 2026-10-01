#!/usr/bin/env node
// Public page gate: a11y (axe WCAG 2.2 AA), SEO/canonical/robots, OG tags, broken links,
// console errors and optional screenshot baselines for every public HTML page.
// Usage: node scripts/qa2/public-pages.mjs --origin URL [--known "/path:substring,..."] [--json out.json] [--shots dir] [--baseline dir] [--chrome /usr/bin/google-chrome]
// Exit 1 when a page fails the gate (axe serious/critical, missing title/canonical/lang, broken internal link, 5xx).
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { argv, exit } from "node:process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : d; };
const origin = arg("origin", "http://127.0.0.1:4173");
const shots = arg("shots"), baseline = arg("baseline");
const compare = ["project-room-vs-slack", "project-room-vs-discord", "agent-collaboration-tool", "multi-agent-workspace", "ai-agent-coordination", "project-room-vs-agent-room"];
const pages = ["/", "/about", "/offers", "/join.html", "/receipts", ...compare.map(s => `/compare/${s}`)];
const known = (arg("known", "") || "").split(",").filter(Boolean).map(k => { const i = k.indexOf(":"); return [k.slice(0, i), k.slice(i + 1)]; }); // e.g. "/:color-contrast,/join.html:broken link"
const waived = (path, problem) => known.some(([p, sub]) => p === path && problem.includes(sub));

const browser = await chromium.launch({ executablePath: arg("chrome", process.env.CHROME_PATH || undefined) });
const results = [];
const linkCache = new Map();
async function checkLink(href) {
  if (linkCache.has(href)) return linkCache.get(href);
  let status = 0;
  try { const r = await fetch(href, { method: "GET", redirect: "manual", headers: { "user-agent": "project-room-qa2-links/1" } }); status = r.status; await r.arrayBuffer(); } catch { status = -1; }
  linkCache.set(href, status); return status;
}
for (const path of pages) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await context.newPage();
  const consoleErrors = [], failedRequests = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("response", r => { if (r.status() >= 400 && new URL(r.url()).origin === new URL(origin).origin) failedRequests.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const rec = { path, problems: [], warnings: [] };
  try {
    const resp = await page.goto(origin + path, { waitUntil: "load", timeout: 45000 });
    rec.status = resp.status(); rec.xRobots = resp.headers()["x-robots-tag"] ?? null;
    if (rec.status === 404) { rec.warnings.push("404 (page not deployed)"); results.push(rec); await context.close(); continue; }
    if (rec.status >= 400) rec.problems.push(`HTTP ${rec.status}`);
    await page.waitForTimeout(800);
    const meta = await page.evaluate(() => ({
      title: document.title, lang: document.documentElement.lang,
      description: document.querySelector('meta[name="description"]')?.content ?? null,
      canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
      robots: document.querySelector('meta[name="robots"]')?.content ?? null,
      ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? null,
      ogImage: document.querySelector('meta[property="og:image"]')?.content ?? null,
      h1: [...document.querySelectorAll("h1")].map(h => h.textContent.trim().slice(0, 80)),
      icon: document.querySelector('link[rel~="icon"]')?.href ?? null,
      links: [...document.querySelectorAll("a[href]")].map(a => a.href).filter(h => /^https?:/.test(h)),
    }));
    Object.assign(rec, { ...meta, links: undefined, linkCount: meta.links.length });
    if (!meta.title) rec.problems.push("missing <title>");
    if (!meta.lang) rec.problems.push("missing <html lang>");
    if (meta.h1.length !== 1) rec.warnings.push(`${meta.h1.length} <h1> elements`);
    const indexable = !/noindex/.test(`${meta.robots} ${rec.xRobots}`);
    rec.indexable = indexable;
    if (indexable && !meta.canonical) rec.problems.push("indexable page without rel=canonical");
    if (indexable && !meta.description) rec.warnings.push("no meta description");
    if (indexable && !meta.ogTitle) rec.warnings.push("no og:title");
    const sameOrigin = [...new Set(meta.links.filter(h => new URL(h).origin === new URL(origin).origin).map(h => h.split("#")[0]))];
    for (const href of sameOrigin) { const s = await checkLink(href); if (s >= 400 || s < 0) rec.problems.push(`broken link ${new URL(href).pathname} -> ${s}`); }
    rec.consoleErrors = consoleErrors; rec.failedRequests = [...new Set(failedRequests)];
    if (rec.failedRequests.length) rec.warnings.push(`same-origin 4xx/5xx subresources: ${rec.failedRequests.join(", ")}`);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    rec.axe = axe.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map(n => n.target.join(" ")) }));
    for (const v of rec.axe) if (["serious", "critical"].includes(v.impact)) rec.problems.push(`axe ${v.impact} ${v.id} x${v.nodes} (${v.targets.join(" | ")})`);
    for (const vp of [{ name: "desktop", w: 1280, h: 900 }, { name: "mobile", w: 390, h: 844 }]) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) rec.problems.push(`${vp.name}: horizontal overflow ${overflow}px`);
      if (shots) {
        mkdirSync(shots, { recursive: true });
        const file = join(shots, `${path.replace(/[^a-z0-9]+/gi, "_") || "home"}-${vp.name}.png`);
        await page.screenshot({ path: file, fullPage: false, animations: "disabled" });
        if (baseline) {
          const base = join(baseline, file.split("/").pop());
          if (existsSync(base) && readFileSync(base).length && Math.abs(readFileSync(base).length - readFileSync(file).length) / readFileSync(base).length > 0.15) rec.warnings.push(`${vp.name}: screenshot size drift >15% vs baseline (review visually)`);
        }
      }
    }
  } catch (e) { rec.problems.push(`error ${e.message.slice(0, 160)}`); }
  rec.waived = rec.problems.filter(x => waived(path, x)); rec.problems = rec.problems.filter(x => !waived(path, x));
  results.push(rec); await context.close();
}
await browser.close();
// sitemap coverage
const sm = await (await fetch(`${origin}/sitemap.xml`)).text().catch(() => "");
const indexed = results.filter(r => r.indexable && r.status === 200).map(r => r.path);
const missingFromSitemap = indexed.filter(p => !sm.includes(`${p === "/" ? "" : p}</loc>`) && !(p === "/" && /\/<\/loc>/.test(sm)));
const fail = results.filter(r => r.problems.length);
console.log(`public pages: ${results.length} checked, ${fail.length} failing`);
for (const r of results) console.log(`${r.problems.length ? "FAIL" : "ok  "} ${r.path} [${r.status}] ${[...r.problems, ...(r.waived ?? []).map(w => `known: ${w}`), ...r.warnings.map(w => `warn: ${w}`)].join("; ")}`);
if (missingFromSitemap.length) console.log(`warn: indexable pages missing from sitemap.xml: ${missingFromSitemap.join(", ")}`);
if (arg("json")) writeFileSync(arg("json"), JSON.stringify({ origin, at: new Date().toISOString(), results, missingFromSitemap }, null, 2));
exit(fail.length ? 1 : 0);
