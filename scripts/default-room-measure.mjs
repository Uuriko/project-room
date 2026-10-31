// Measures the default room as the owner of a seeded human+agent journey:
// visible controls, requests (and JS module requests), DOM nodes and ready
// time at 390px and 1280px. Usage: node scripts/default-room-measure.mjs [label] [shotDir]
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";

export async function measureDefaultRoom({ label = "run", shotDir = null, widths = [390, 1280] } = {}) {
  const f = createAcceptanceFixture(); f.store.roomFlood = { consume() {} };
  const say = (who, id, body) => f.store.command(f.keys[who], "commons", { id, type: "message.posted", data: { messageId: id, body } });
  say("owner", "m1", "Could you draft the onboarding checklist?");
  say("producer", "m2", "On it. I will post the result on the Board item.");
  f.store.command(f.keys.owner, "commons", { id: "w1", type: "work.proposed", data: {
    workItemId: "checklist", title: "Draft onboarding checklist", definitionOfDone: "A reviewed checklist",
    accountableMemberId: "producer", mode: "read" } });
  const server = createRoomServer({ store: f.store, streamInterval: 30 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 } });
      await page.goto(origin);
      await signInFixture(page, f.keys.owner);
      await page.locator('[data-message-record-id="m2"]').waitFor({ timeout: 15000 });
      const requests = [];
      page.on("request", request => requests.push(request));
      const started = Date.now();
      await page.reload();
      await page.locator('[data-message-record-id="m2"]').waitFor({ timeout: 15000 });
      const readyMs = Date.now() - started;
      await page.waitForTimeout(1500);
      const counts = await page.evaluate(() => {
        const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("[hidden],dialog:not([open])") && !inClosedDetails(el) && !transparent(el); };
        const inClosedDetails = el => { for (let d = el.parentElement?.closest("details:not([open])"); d; d = d.parentElement?.closest("details:not([open])")) { if (!(el.tagName === "SUMMARY" && el.parentElement === d)) return true; if (el.parentElement === d) return false; } return false; };
        const transparent = el => { for (let n = el; n; n = n.parentElement) if (getComputedStyle(n).opacity === "0") return true; return false; };
        const controls = [...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button],summary')].filter(visible);
        return { controls: controls.length, domNodes: document.querySelectorAll("*").length,
          labels: controls.map(el => (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || el.id || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40)) };
      });
      const modules = requests.filter(r => r.resourceType() === "script").map(r => new URL(r.url()).pathname);
      if (shotDir) { mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: join(shotDir, `${label}-${width}.png`), fullPage: false }); }
      results.push({ width, readyMs, requests: requests.length, scripts: modules.length, apiReads: requests.filter(r => new URL(r.url()).pathname.startsWith("/api/")).length, ...counts, modules });
      await page.close();
    }
  } finally {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await measureDefaultRoom({ label: process.argv[2] ?? "run", shotDir: process.argv[3] ?? null });
  for (const r of results) console.log(JSON.stringify({ width: r.width, readyMs: r.readyMs, requests: r.requests, scripts: r.scripts, apiReads: r.apiReads, controls: r.controls, domNodes: r.domNodes }));
  if (process.env.MEASURE_VERBOSE) for (const r of results) console.log(r.width, JSON.stringify(r.labels), JSON.stringify(r.modules));
}
