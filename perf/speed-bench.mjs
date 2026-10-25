#!/usr/bin/env node
// Before/after page weight for the client bundle (FIX12-2).
// `before` is the raw ES module graph `src/entry.js` pulls in, served the
// way dev does. `after` is the minified content-hashed build.
//
//   node perf/speed-bench.mjs
//   node perf/speed-bench.mjs --no-browser
//
// Prints one JSON object. Browser timings need Playwright Chromium.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAssets } from "../cloudflare/build-assets.mjs";
import { buildClient, byteSize, sourceModuleGraph } from "../scripts/build-client.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const STYLES = ["src/styles.css", "src/login-polish.css", "src/board.css", "src/public-a11y.css", "src/human-experience.css"];

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function closeServer(server, store) {
  server.closeStreams?.();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  store.close();
}

async function start(assetRoot) {
  const store = new RoomStore(":memory:");
  const server = createRoomServer(assetRoot ? { store, assetRoot } : { store });
  const origin = await listen(server);
  return { origin, close: () => closeServer(server, store) };
}

async function timedLoad(page, origin) {
  const paths = [];
  const onRequest = request => {
    const url = request.url();
    if (url.startsWith(origin)) paths.push(new URL(url).pathname);
  };
  page.on("request", onRequest);
  const started = Date.now();
  await page.goto(origin + "/", { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.querySelector("#identity-label")?.textContent === "Not signed in", null, { timeout: 20000 });
  const loadMs = Date.now() - started;
  page.off("request", onRequest);
  const resources = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const entries = performance.getEntriesByType("resource").map(entry => ({
      path: new URL(entry.name).pathname,
      transfer: entry.transferSize,
    }));
    return {
      documentTransfer: navigation ? navigation.transferSize : 0,
      entries,
    };
  });
  // Signed-out interaction that stays on the page: focus the email field and type.
  const interactionStarted = Date.now();
  const email = page.locator("#auth-signin-ui input[name='email']");
  await email.click({ timeout: 5000 });
  await email.pressSequentially("a");
  await page.waitForFunction(() => document.querySelector("#auth-signin-ui input[name='email']")?.value === "a");
  const interactionMs = Date.now() - interactionStarted;
  const js = resources.entries.filter(entry => entry.path.endsWith(".js"));
  const transferred = resources.entries.reduce((sum, entry) => sum + entry.transfer, 0) + resources.documentTransfer;
  return {
    loadMs,
    interactionMs,
    requests: paths.length,
    jsRequests: js.length,
    jsTransferredBytes: js.reduce((sum, entry) => sum + entry.transfer, 0),
    transferredBytes: transferred,
    uniqueRequests: new Set(paths).size,
  };
}

async function browserLoads(origin) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}),
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    const cold = await timedLoad(page, origin);
    const warm = await timedLoad(page, origin);
    if (errors.length) throw new Error(errors.join("\n"));
    return { cold, warm };
  } finally {
    await browser.close();
  }
}

export async function measureClientSpeed({ browser = true } = {}) {
  const graph = sourceModuleGraph();
  const before = { js: byteSize(graph), css: byteSize(STYLES) };
  before.requests = 1 + before.js.files + before.css.files;
  const directory = await mkdtemp(join(tmpdir(), "room-speed-"));
  try {
    const output = pathToFileURL(directory + "/");
    await buildAssets(output);
    const built = await buildClient(output);
    const after = {
      js: { files: built.files.length, rawBytes: built.rawBytes, gzipBytes: built.gzipBytes },
      css: before.css,
      entry: built.entries["src/entry.js"],
    };
    after.requests = 1 + after.js.files + after.css.files;
    const result = {
      before,
      after,
      delta: {
        jsFiles: after.js.files - before.js.files,
        jsRawBytes: after.js.rawBytes - before.js.rawBytes,
        jsGzipBytes: after.js.gzipBytes - before.js.gzipBytes,
        requests: after.requests - before.requests,
      },
    };
    if (!browser) return result;
    const rawServer = await start();
    const bundledServer = await start(output);
    try {
      result.load = {
        before: await browserLoads(rawServer.origin),
        after: await browserLoads(bundledServer.origin),
      };
    } finally {
      await rawServer.close();
      await bundledServer.close();
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const browser = !process.argv.includes("--no-browser");
  const result = await measureClientSpeed({ browser });
  console.log(JSON.stringify(result, null, 2));
}
