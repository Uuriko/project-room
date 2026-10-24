import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const started = new URL("../src/entry-started.js", import.meta.url).href;

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const critical = html.match(/<style id="critical-hero">([\s\S]*?)<\/style>/)[1];
const hash = createHash("sha256").update(critical).digest("base64");

test("the landing hero paints from a hashed style and defers the stylesheets", () => {
  const hero = html.match(/<section id="static-hero"[\s\S]*?<\/section>/)[0];
  assert.ok(!hero.includes("<style"));
  for (const name of ["--bg", "--text", "--muted", "--line", "--amber", "--blue"]) {
    const value = styles.match(new RegExp(`${name}:(#[0-9a-f]{6})`))[1];
    assert.ok(critical.includes(`${name}:${value}`), name);
  }
  assert.match(critical, /html:not\(\[data-entry-started\]\) \.app-shell>:not\(#static-hero\)\{display:none\}/);
  for (const file of ["styles.css", "login-polish.css", "board.css", "public-a11y.css", "human-experience.css"]) {
    assert.match(html, new RegExp(`<link rel="preload" href="\\./src/${file}" as="style" data-defer-css>`));
  }
  assert.doesNotMatch(html, /<link rel="stylesheet" href="\.\/src\//);
  for (const file of ["server/http.mjs", "cloudflare/edge-public.mjs"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`style-src 'self' 'sha256-${hash}'`));
  }
});

test("startup reveals the shell after deferred styles load, and immediately when there are none", async t => {
  const previous = globalThis.document;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const none = { documentElement: { dataset: {} }, querySelectorAll: () => [] };
  globalThis.document = none;
  await import(started + "?none");
  assert.equal(none.documentElement.dataset.entryStarted, "true");

  const link = { rel: "preload", listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  const deferred = { documentElement: { dataset: {} }, querySelectorAll: selector => selector === "link[data-defer-css]" ? [link] : [] };
  globalThis.document = deferred;
  await import(started + "?defer");
  assert.equal(deferred.documentElement.dataset.entryStarted, undefined);
  assert.equal(link.rel, "stylesheet");
  link.listeners.load();
  assert.equal(deferred.documentElement.dataset.entryStarted, "true");
});
