#!/usr/bin/env node
// Landing inventory for FIX12-7. Serves index.html and prints HTML bytes,
// DOM nodes, DOM buttons, accessibility-tree buttons, and first contentful paint.
// Chrome: CHROME_PATH=/usr/bin/google-chrome node perf/ui-inventory.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const html = readFileSync(new URL("../index.html", import.meta.url));
const server = createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
const dom = await page.evaluate(() => ({
  nodes: document.getElementsByTagName("*").length,
  buttons: document.querySelectorAll("button").length,
  hidden: document.querySelectorAll("[hidden]").length,
}));
const client = await page.context().newCDPSession(page);
const tree = await client.send("Accessibility.getFullAXTree");
const a11yButtons = tree.nodes.filter(node => node.role?.value === "button" && node.ignored !== true).length;
const fcpMs = await page.evaluate(async () => {
  const read = () => performance.getEntriesByType("paint").find(entry => entry.name === "first-contentful-paint")?.startTime ?? null;
  const first = read();
  if (first != null) return first;
  return await new Promise(resolve => {
    const done = () => resolve(read());
    try {
      new PerformanceObserver(done).observe({ type: "paint", buffered: true });
    } catch {
      done();
    }
    setTimeout(done, 500);
  });
});
console.log(JSON.stringify({ bytes: html.byteLength, ...dom, a11yButtons, fcpMs }));
await browser.close();
server.close();
