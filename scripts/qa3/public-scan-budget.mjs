#!/usr/bin/env node
// Seed 1,000 rooms through the store, then require the public routes to
// stay under 50 ms p95. PRM owns the separate assertion that no public
// route reads rooms.projection. This 1,000-room fixture already meets the
// timing bar, so the check is required: a regression fails the job.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../../server/store.mjs";
import { createRoomServer } from "../../server/http.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { event, EVENT_TYPES as T } from "../../src/events.js";
import { createReport } from "./lib/summary.mjs";

const BUDGET_MS = 50;
const ROOMS = 1000;
const SAMPLES = 20;
const report = createReport("qa3 public-scan-budget");

function p95(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

async function sample(url) {
  const started = performance.now();
  const response = await fetch(url);
  await response.arrayBuffer();
  return { status: response.status, ms: performance.now() - started };
}

try {
  const directory = mkdtempSync(join(tmpdir(), "qa3-scan-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const slug = "qa3page";
  store.initialize([
    ...initialRoom(slug, "owner"),
    event({ type: T.ROOM_PUBLIC_PAGE_SET, actorId: "owner", roomId: slug, data: { enabled: true } }),
  ]);
  for (let i = 0; i < ROOMS - 1; i++) {
    const id = `r${String(i).padStart(4, "0")}`;
    store.initialize(initialRoom(id, "owner"));
  }
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const routes = [
      ["/receipts", `${origin}/receipts`],
      ["/api/public/receipts", `${origin}/api/public/receipts`],
      ["/sitemap.xml", `${origin}/sitemap.xml`],
      [`/r/${slug}`, `${origin}/r/${slug}`],
      ["/agents", `${origin}/agents`],
    ];
    const checks = [];
    for (const [name, url] of routes) {
      const warm = await sample(url);
      if (warm.status !== 200) throw new Error(`${name} warmup HTTP ${warm.status}`);
      const samples = [];
      for (let i = 0; i < SAMPLES; i++) {
        const once = await sample(url);
        if (once.status !== 200) throw new Error(`${name} HTTP ${once.status}`);
        samples.push(once.ms);
      }
      const elapsed = p95(samples);
      checks.push({ name, ok: elapsed < BUDGET_MS, detail: `p95 ${elapsed.toFixed(1)} ms` });
    }
    for (const check of checks) {
      if (check.ok) report.pass(`${check.name} ${check.detail}`);
      else report.fail(check.name, `${check.detail}; budget ${BUDGET_MS} ms`);
    }
  } finally {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(report.finish());
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(2);
}
