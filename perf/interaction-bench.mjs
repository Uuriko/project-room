// Interaction bench: room switch, channel switch, search, DOM after switches.
//
//   node perf/interaction-bench.mjs [--repo .] [--rtt 40] [--n 10] [--older 2100]
//
// Prints one JSON object on stdout. Does not print credentials.
// Node 24. The local server is started with a GitHub auth stub so the front
// door keeps its GitHub control. The stub does not sign anyone in. Leave this
// file separate from perf/speed-bench.mjs while that bench's pull request is open.
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf("--" + name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const REPO = resolve(opt("repo", "."));
const RTT = Number(opt("rtt", 40));
const N = Number(opt("n", 10));
const OLDER = Number(opt("older", 2100));
const SWITCHES = 10;
const QA10 = {
  commit: "6f640d000",
  rttMs: 40,
  channelSwitchMs: { p50: 66, p95: 100 },
  searchLaterP50Ms: 17,
  searchFirstMs: 1297,
  domNodes: 6448
};

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error("interaction bench needs Node 24 (node:sqlite)");
  process.exit(1);
}
if (!Number.isFinite(RTT) || RTT < 0 || !Number.isInteger(N) || N < 4 || !Number.isInteger(OLDER) || OLDER < 200) {
  console.error("usage: node perf/interaction-bench.mjs [--repo .] [--rtt 40] [--n 10] [--older 2100]");
  process.exit(1);
}

const stat = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  const q = p => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
  return { p50: q(0.5), p95: q(0.95), n: sorted.length };
};
const within = (actual, expected) => Math.abs(actual - expected) <= expected * 0.2;
const load = file => import(pathToFileURL(join(REPO, file)).href);

const browserPath = process.env.CHROME || process.env.ROOM_TEST_CHROMIUM_PATH || "/usr/bin/google-chrome";
const { chromium } = await import(join(REPO, "node_modules/playwright/index.mjs")).catch(() => import("playwright"));

function lineBody(kind, i) {
  if (kind === "token") return "quartzledger sits in older history only";
  const word = kind === "general" ? "deploy" : kind === "design" ? "layout" : "planning";
  // #design notes carry a longer list plus bold and italic, so that channel's
  // render is the heavier of the two. The timed run ends on #general, where
  // the DOM count is taken.
  if (kind === "design") {
    return [
      `@Bench reader design **${word}** note ${i} for the *board*`,
      "- first step",
      "- second step",
      "- third step",
      "- fourth step",
      "- fifth step",
      "- sixth step",
      "- seventh step",
      "- eighth step"
    ].join("\n");
  }
  return `@Bench reader ${kind} ${word} note ${i}\n- first step\n- second step`;
}

function seedRoom(store, key, roomId, older) {
  store.command(key, roomId, { id: `ch-${roomId}-design`, type: "channel.created", data: { channelId: "design", name: "design" } });
  for (let i = 0; i < older; i++) {
    const channelId = i % 2 === 0 ? "general" : "design";
    const body = i === 0 && roomId === "commons" ? lineBody("token", i) : lineBody(channelId === "general" ? "general" : "design", i);
    store.command(key, roomId, {
      id: `old-${roomId}-${i}`,
      type: "message.posted",
      data: { messageId: `old-${roomId}-${i}`, channelId, body }
    });
  }
  for (let i = 0; i < 24; i++) {
    store.command(key, roomId, {
      id: `lane-${roomId}-g-${i}`,
      type: "message.posted",
      data: { messageId: `lane-${roomId}-g-${i}`, channelId: "general", body: lineBody("general", i) }
    });
    store.command(key, roomId, {
      id: `lane-${roomId}-d-${i}`,
      type: "message.posted",
      data: { messageId: `lane-${roomId}-d-${i}`, channelId: "design", body: lineBody("design", i) }
    });
  }
  store.command(key, roomId, {
    id: `newest-${roomId}-g`,
    type: "message.posted",
    data: { messageId: `${roomId}-general-newest`, channelId: "general", body: `${roomId} general newest marker` }
  });
  store.command(key, roomId, {
    id: `newest-${roomId}-d`,
    type: "message.posted",
    data: { messageId: `${roomId}-design-newest`, channelId: "design", body: `${roomId} design newest marker` }
  });
}

async function emulate(context, page) {
  if (!RTT) return;
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: RTT,
    downloadThroughput: 20e6 / 8,
    uploadThroughput: 5e6 / 8
  });
}

async function openSearch(page) {
  const form = page.locator("#search-form");
  if (await form.isHidden()) await page.locator("#topbar-search-toggle").click();
  await form.waitFor({ state: "visible" });
}

// Time from setting the query until a result link is laid out and one frame
// has followed. The clock starts on a frame. A match that is already loaded
// then costs about one frame. The first call pays for history the recent
// window does not hold. Later calls search what is already loaded.
async function timeSearch(page, query) {
  const input = page.locator("#message-search");
  await input.fill("");
  await page.waitForFunction(() => document.querySelectorAll("#search-list a").length === 0);
  const ms = await page.evaluate(async needle => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const field = document.querySelector("#message-search");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const started = performance.now();
    setter.call(field, needle);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: needle }));
    const want = needle.toLowerCase();
    const deadline = started + 20000;
    while (performance.now() < deadline) {
      const hit = document.querySelector("#search-list a");
      if (hit && hit.textContent.toLowerCase().includes(want) && hit.getBoundingClientRect().height > 0) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        return performance.now() - started;
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return -1;
  }, query);
  if (ms < 0) throw new Error(`search for ${query} failed`);
  return +ms.toFixed(1);
}

async function timeChannelSwitch(page, channelId, messageId) {
  const ms = await page.evaluate(async ({ channelId, messageId }) => {
    const button = document.querySelector(`#channel-list [data-channel="${channelId}"]`);
    if (!button) return -2;
    if (button.getAttribute("aria-current") === "page") return -3;
    const started = performance.now();
    button.click();
    const deadline = started + 8000;
    while (performance.now() < deadline) {
      const node = document.querySelector(`[data-message-record-id="${messageId}"]`);
      if (node && node.getBoundingClientRect().height > 0) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        return performance.now() - started;
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return -1;
  }, { channelId, messageId });
  if (ms < 0) throw new Error(`channel switch to ${channelId} failed (${ms})`);
  return +ms.toFixed(1);
}

async function timeRoomSwitch(page, roomId, messageId) {
  await page.locator("#nav-rooms").click();
  const row = page.locator(`[data-account-room="${roomId}"]`);
  await row.waitFor();
  const ms = await page.evaluate(async ({ roomId, messageId }) => {
    const button = document.querySelector(`[data-account-room="${roomId}"]`);
    if (!button) return -2;
    if (document.querySelector(`[data-message-record-id="${messageId}"]`)) return -3;
    const started = performance.now();
    button.click();
    const deadline = started + 20000;
    while (performance.now() < deadline) {
      if (document.querySelector(`[data-message-record-id="${messageId}"]`)) return performance.now() - started;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return -1;
  }, { roomId, messageId });
  if (ms < 0) throw new Error(`room switch to ${roomId} failed (${ms})`);
  await page.locator("#main").waitFor({ state: "visible" });
  return +ms.toFixed(1);
}

async function coldLoad(browser, storageState, origin) {
  const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await emulate(context, page);
  let jsBytes = 0;
  let requests = 0;
  page.on("response", async response => {
    requests += 1;
    if (response.request().resourceType() !== "script") return;
    const length = Number(response.headers()["content-length"] || 0);
    if (length) { jsBytes += length; return; }
    try { jsBytes += (await response.body()).length; } catch { /* closed before the body was read */ }
  });
  const started = performance.now();
  await page.goto(origin + "/?room=commons", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator('[data-message-record-id="commons-general-newest"]').waitFor({ timeout: 30000 });
  const readyMs = Math.round(performance.now() - started);
  await page.close();
  await context.close();
  return { readyMs, jsKB: Math.round(jsBytes / 1024), requests };
}

const { createAcceptanceFixture } = await load("scripts/acceptance-fixture.mjs");
const { createRoomServer } = await load("server/http.mjs");
const { signInFixture } = await load("scripts/auth-signin.mjs");
const { initialRoom } = await load("server/bootstrap.mjs");
const { PERMISSIONS } = await load("src/events.js");

const fixture = createAcceptanceFixture();
fixture.store.roomFlood = { consume() {} };
let server;
let browser;
const deadline = setTimeout(() => {
  console.error("interaction bench exceeded 110s");
  process.exit(1);
}, 110000);
try {
  fixture.store.createAccount("bench-owner");
  fixture.store.completeOnboarding("bench-owner");
  fixture.store.command(fixture.keys.owner, "commons", {
    id: "add-bench",
    type: "member.added",
    data: { memberId: "bench", displayName: "Bench reader", kind: "human", permissions: [...PERMISSIONS] }
  });
  fixture.store.bindHumanAccount("commons", "bench", "bench-owner");
  fixture.store.initialize(initialRoom("studio", "bench"));
  fixture.store.bindHumanAccount("studio", "bench", "bench-owner");
  const studioKey = fixture.store.issueAccessKey("studio", "bench");
  const seededAt = performance.now();
  seedRoom(fixture.store, fixture.keys.owner, "commons", OLDER);
  seedRoom(fixture.store, studioKey, "studio", 40);
  const seedMs = Math.round(performance.now() - seededAt);

  server = createRoomServer({
    store: fixture.store,
    streamInterval: 30,
    // Keeps the GitHub control on the front door. Not a sign-in.
    githubAuth: { clientId: "fixture-client", clientSecret: "fixture-secret", fetchImpl: async () => { throw new Error("github auth stub"); } } // secrets-allowlist (fixture value, not a credential)
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(String(error.message).slice(0, 180)));
  page.on("dialog", dialog => dialog.accept());
  await emulate(context, page);
  await page.goto(origin + "/?room=commons", { waitUntil: "domcontentloaded" });
  await signInFixture(page, fixture.store.issueAccountAccessKey("bench-owner"));
  await page.locator('[data-message-record-id="commons-general-newest"]').waitFor({ timeout: 30000 });

  await openSearch(page);
  const searchFirstMs = await timeSearch(page, "quartzledger");
  const laterWords = ["deploy", "layout", "step", "marker"];
  const later = [];
  for (let i = 0; i < N; i++) later.push(await timeSearch(page, laterWords[i % laterWords.length]));
  await page.locator("#message-search").fill("");

  const channels = [];
  for (let i = 0; i < SWITCHES; i++) {
    const channelId = i % 2 === 0 ? "design" : "general";
    channels.push(await timeChannelSwitch(page, channelId, `commons-${channelId}-newest`));
  }
  const domNodesAfterSwitches = await page.evaluate(() => document.getElementsByTagName("*").length);

  const sends = [];
  for (let i = 0; i < 5; i++) {
    const text = `bench send ${i} ${Date.now()}`;
    await page.locator("#message-input").fill(text);
    const started = performance.now();
    await page.locator("#message-input").press("Enter");
    await page.getByText(text, { exact: false }).first().waitFor({ timeout: 15000 });
    sends.push(+(performance.now() - started).toFixed(1));
  }

  const rooms = [];
  const roomTargets = [
    ["studio", "studio-general-newest"],
    ["commons", "commons-general-newest"]
  ];
  for (let i = 0; i < 6; i++) {
    const [roomId, messageId] = roomTargets[i % 2];
    rooms.push(await timeRoomSwitch(page, roomId, messageId));
  }

  const storageState = await context.storageState();
  const cold = await coldLoad(browser, storageState, origin);
  const channelSwitch = stat(channels);
  const searchLater = stat(later);
  const roomSwitch = stat(rooms);
  const ownSend = stat(sends);
  const qa10 = {
    channelP50: within(channelSwitch.p50, QA10.channelSwitchMs.p50),
    channelP95: within(channelSwitch.p95, QA10.channelSwitchMs.p95),
    searchLaterP50: within(searchLater.p50, QA10.searchLaterP50Ms),
    searchFirst: within(searchFirstMs, QA10.searchFirstMs),
    domNodes: within(domNodesAfterSwitches, QA10.domNodes)
  };
  const report = {
    bench: "interaction",
    node: process.version,
    rttMs: RTT,
    network: RTT ? "20 Mbps down / 5 up" : "loopback",
    olderMessages: OLDER,
    seedMs,
    pageErrorCount: pageErrors.length,
    channelSwitch,
    channelSwitchSamplesMs: channels,
    searchFirstMs,
    searchLater,
    searchLaterSamplesMs: later,
    domNodesAfterSwitches,
    switches: SWITCHES,
    roomSwitch,
    roomSwitchSamplesMs: rooms,
    ownSend,
    cold,
    qa10Target: QA10,
    qa10Within20Percent: qa10,
    qa10AllWithin20Percent: Object.values(qa10).every(Boolean)
  };
  console.log(JSON.stringify(report, null, 1));
} finally {
  clearTimeout(deadline);
  await browser?.close().catch(() => {});
  server?.closeStreams?.();
  server?.closeAllConnections?.();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  fixture.store.close?.();
  if (fixture.directory) {
    try { rmSync(fixture.directory, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}
