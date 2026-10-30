#!/usr/bin/env node
// Reuse existing real-app browser journeys. No baseline refresh or product UI.
// node scripts/design-evidence-gallery.mjs --out /absolute/new-directory
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const JOURNEYS = [
  { script: "scripts/access-preview-browser-check.mjs", pattern: "^request access at", fixture: "Identity admission request with injected first-response failure and real retry" },
  { script: "scripts/a11y-login-browser-check.mjs", pattern: "login/join entry points", fixture: "Disposable RoomStore and real agent invite" },
  { script: "scripts/auth-journeys-browser-check.mjs", pattern: "^signup, then verify", fixture: "Password signup with synthetic local email" },
  { script: "scripts/room-lifecycle-browser-check.mjs", pattern: "create from Rooms", fixture: "Authenticated admin creates a new room" },
  { script: "scripts/member-perms-browser-check.mjs", pattern: "a basic member requests by keyboard", fixture: "Member permissions and agent join request reviewed by owner" },
];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function renderGallery(report) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Project Room design evidence</title>
<style>body{font:16px system-ui;margin:2rem;background:#f6f6f6;color:#181818}main{max-width:1300px;margin:auto}h1{margin-bottom:.4rem}code{overflow-wrap:anywhere}section{background:white;padding:1rem;margin:1rem 0;border:1px solid #ccc;border-radius:8px}img{max-width:100%;height:auto;border:1px solid #ddd}dl{display:grid;grid-template-columns:10rem 1fr;gap:.3rem}dd{margin:0}nav a{margin-right:1rem}small{color:#444}.failure{color:#9b1717}details{margin:.5rem 0}</style><main>
<h1>Project Room design evidence</h1><p>Real local app states, disposable fixtures. Not a mockup, human study, production or real-provider sign-in proof.</p>
<p>Source <code>${escape(report.source.commit)}</code> · tree <code>${escape(report.source.tree)}</code> · ${report.source.dirty ? "dirty source (fingerprint below)" : "clean source"}. Browser ${escape(report.environment.playwright)} · Node ${escape(report.environment.node)} · ${escape(report.environment.platform)}.</p>
<p class="${report.passed ? "" : "failure"}"><strong>Overall evidence: ${report.passed ? "passed" : "NOT passed"}. Source stable during capture: ${report.sourceStable ? "yes" : "NO / unknown"}.</strong></p>
<p><a href="manifest.json">Machine-readable provenance and results</a> · ${report.captures.length} captures. ${report.runs.filter(r => r.status !== 0).length} failed journeys. Axe findings are observations; the original suite result remains separate. No screen-reader claim.</p>
<p>Coverage gaps: real Google/email delivery, human-account owner admission (captured admission uses a self-serve identity), alternate themes/high-contrast preferences, and unlisted component states. Login fixture has no configured Google provider; absence of that button is not production evidence. Signup is desktop-only; login, invite, access requests, room creation and owner requests include desktop/phone widths. Fixture sign-in bypasses external authentication where named.</p>
<nav>${report.captures.map(c => `<a href="#${escape(c.id)}">${escape(c.title)} ${c.viewport.width}px</a>`).join(" ")}</nav>
${report.runs.map(r => `<p class="${r.status === 0 ? "" : "failure"}">${escape(r.script)}: ${r.status === 0 ? "passed" : "failed"} (${r.durationMs}ms), ${r.captureCount} captures; <a href="${escape(r.log)}">local test log</a></p>`).join("")}
${report.captures.map(c => `<section id="${escape(c.id)}"><h2>${escape(c.title)} · ${c.viewport.width} × ${c.viewport.height}</h2><dl><dt>Browser/theme</dt><dd>${escape(c.browserVersion ?? "unknown")} · ${escape(JSON.stringify(c.theme ?? {}))}</dd><dt>Component/state</dt><dd>${escape(c.component)}</dd><dt>Fixture</dt><dd>${escape(c.fixture)}</dd><dt>Test</dt><dd>${escape(c.script)} — ${escape(c.testName)}</dd><dt>Journey result</dt><dd>${c.testPassed ? "passed" : "failed — capture alone is not a pass"}</dd><dt>Axe serious/critical</dt><dd>${c.accessibility.serious.length}</dd><dt>Screenshot SHA256</dt><dd><code>${escape(c.sha256)}</code></dd></dl><details><summary>Accessibility findings</summary><pre>${escape(JSON.stringify(c.accessibility, null, 2))}</pre></details><a href="${escape(c.screenshot)}"><img loading="lazy" src="${escape(c.screenshot)}" alt="${escape(c.title)} at ${c.viewport.width}px from ${escape(c.fixture)}"></a></section>`).join("")}</main></html>`;
}

export function readCaptures(directory, run, prefix) {
  return readdirSync(directory).filter(name => name.endsWith(".json")).sort().map(name => {
    const item = JSON.parse(readFileSync(join(directory, name), "utf8"));
    if (!/^[a-z0-9-]+$/.test(item.id) || item.screenshot !== item.id + ".png"
      || !Number.isSafeInteger(item.viewport?.width) || !Number.isSafeInteger(item.viewport?.height)
      || !Array.isArray(item.accessibility?.serious) || !Array.isArray(item.accessibility?.other)) throw new Error("Invalid capture metadata");
    if (sha(readFileSync(join(directory, item.screenshot))) !== item.sha256) throw new Error("Screenshot digest mismatch");
    return { ...item, screenshot: `${prefix}/${item.screenshot}`, script: run.script, testPassed: run.status === 0 };
  });
}

export function generateGallery(output) {
  const out = resolve(output);
  if (existsSync(out) && readdirSync(out).length) throw new Error("Use a new or empty output directory");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  // Bind actual working bytes, including optional untracked tooling, before output is created.
  const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].sort().map(path => ({ path, sha256: existsSync(join(root, path)) ? sha(readFileSync(join(root, path))) : null }));
  const source = { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirty: Boolean(git("status", "--porcelain")),
    filesSha256: sha(JSON.stringify(files)), files };
  mkdirSync(out, { recursive: true });
  const report = { version: 1, generatedAt: new Date().toISOString(), source,
    environment: { node: process.version, platform: `${process.platform}/${process.arch}`, playwright: JSON.parse(readFileSync(join(root, "node_modules/playwright/package.json"))).version }, runs: [], captures: [] };
  for (const [index, journey] of JOURNEYS.entries()) {
    const prefix = `journey-${index + 1}`, directory = join(out, prefix);
    mkdirSync(directory);
    const started = Date.now();
    const child = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${journey.pattern}`, journey.script], {
      cwd: root, env: { ...process.env, ROOM_DESIGN_EVIDENCE_DIR: directory }, encoding: "utf8", timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
    const run = { ...journey, status: child.status, signal: child.signal, durationMs: Date.now() - started, log: `${prefix}.log` };
    writeFileSync(join(out, run.log), (child.stdout ?? "") + (child.stderr ?? "") + (child.error ? `\nRunner error: ${child.error.code}\n` : ""));
    const captures = readCaptures(directory, run, prefix);
    run.captureCount = captures.length;
    if (!captures.length && run.status === 0) run.status = 1;
    report.runs.push(run); report.captures.push(...captures);
  }
  report.sourceStable = files.every(({ path, sha256 }) => (existsSync(join(root, path)) ? sha(readFileSync(join(root, path))) : null) === sha256);
  report.passed = report.sourceStable && report.runs.every(run => run.status === 0);
  writeFileSync(join(out, "manifest.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "index.html"), renderGallery(report));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) console.log("node scripts/design-evidence-gallery.mjs --out /absolute/new-directory\nRuns existing selected local browser journeys; writes index.html, manifest.json, screenshots and logs. No live service access or baseline refresh.");
  else if (!values.out) throw new Error("--out is required");
  else { const result = generateGallery(values.out); console.log(JSON.stringify({ passed: result.passed, captures: result.captures.length, output: resolve(values.out) })); if (!result.passed) process.exitCode = 1; }
}
