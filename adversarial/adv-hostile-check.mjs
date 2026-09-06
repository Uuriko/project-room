// Pass 27: hostile-id / hostile-text injection matrix.
// Default: clean assets MUST pass, then an isolated esc()-identity mutant MUST go red
// on the escaping-dependent DOM checks (teeth). Production src/app.js is never written.
// MODE=mutant: serve only the isolated mutant and apply the same green assertions; that
// run MUST fail (the advertised teeth proof).
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const mutantOnly = process.env.MODE === "mutant";
const repoRoot = new URL("../", import.meta.url);
const appJsPath = new URL("src/app.js", repoRoot);
const ESC = `const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));`;
const IDENTITY = `const esc = value => String(value ?? "");`;

let pass = 0, failCount = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { failCount++; console.log(`FAIL ${name} ${detail}`); }
};

function isolateMutantAssets() {
  const dir = mkdtempSync(join(tmpdir(), "adv-hostile-mutant-"));
  writeFileSync(join(dir, "index.html"), readFileSync(new URL("index.html", repoRoot)));
  mkdirSync(join(dir, "src"));
  for (const name of ["app.js", "client.js", "events.js", "conversation.js", "styles.css"]) {
    let text = readFileSync(new URL(`src/${name}`, repoRoot), "utf8");
    if (name === "app.js") {
      if (!text.includes(ESC)) throw new Error("esc() definition not found; isolated mutation cannot be applied");
      text = text.replace(ESC, IDENTITY);
      if (text.includes(ESC) || !text.includes(IDENTITY)) throw new Error("isolated esc() mutation did not apply");
    }
    writeFileSync(join(dir, "src", name), text);
  }
  return { dir, assetRoot: pathToFileURL(dir + "/") };
}

const directory = mkdtempSync(join(tmpdir(), "adv-hostile-"));
const store = new RoomStore(join(directory, "room.sqlite"));
store.initialize(initialRoom());
const owner = store.issueAccessKey("commons", "owner");
const send = (key, type, data) => store.command(key, "commons", { id: crypto.randomUUID(), type, data });

// 1. Source constraint: hostile and boundary member ids at the event boundary.
const tryAdd = (memberId) => { try { send(owner, T.MEMBER_ADDED, { memberId, displayName: "X", kind: "human", permissions: [] }); return true; } catch { return false; } };
check('memberId with quote/bracket rejected', tryAdd('x"><img src=x>') === false);
check('memberId with space rejected', tryAdd('evil member') === false);
check('memberId "__proto__" rejected', tryAdd('__proto__') === false);
check('memberId "constructor" rejected', tryAdd('constructor') === false);
check('memberId leading "." rejected', tryAdd('.hidden') === false);
check('memberId 129 chars rejected', tryAdd('a'.repeat(129)) === false);
check('memberId 128 chars accepted', tryAdd('a'.repeat(128)) === true);
check('memberId with colon/dot/dash accepted', tryAdd('svc:node-1.a') === true);

// 2. Hostile free text (displayName, message body) - the fields that are NOT id-constrained.
send(owner, T.MEMBER_ADDED, { memberId: 'hostile', displayName: '<img src=x onerror="window.__pwned1=1">', kind: 'human', permissions: [] });
const hostile = store.issueAccessKey('commons', 'hostile');
send(hostile, T.MESSAGE_POSTED, { messageId: 'hm-1', body: '"><svg onload="window.__pwned2=1"></svg>' });
send(hostile, T.MESSAGE_POSTED, { messageId: 'hm-2', body: '<script>window.__pwned3=1</script>' });

const chrome = process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {};
const browser = await chromium.launch({ headless: true, ...chrome });

async function observeUi(assetRoot, withDisclosure) {
  const server = createRoomServer({ store, streamInterval: 60, ...(assetRoot ? { assetRoot } : {}) });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.locator("#access-key").fill(owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  const obs = {
    pwned1: await page.evaluate(() => window.__pwned1 === undefined),
    pwned2: await page.evaluate(() => window.__pwned2 === undefined),
    pwned3: await page.evaluate(() => window.__pwned3 === undefined),
    imgCount: await page.locator('img[src="x"]').count(),
    displayNameAsText: await page.locator("#presence-list").innerText().then(t => t.includes('<img src=x onerror="window.__pwned1=1">')),
    errors
  };
  if (withDisclosure) {
    const otherContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const other = await otherContext.newPage();
    await other.goto(origin);
    await other.locator("#auth-panel").waitFor({ state: "visible" });
    await other.locator("#access-key").fill(hostile);
    await other.getByRole("button", { name: "Enter room", exact: true }).click();
    await other.locator("#main").waitFor({ state: "visible" });
    const card = page.locator('[data-disclosure-host="hostile"]');
    await card.locator("summary").click();
    obs.disclosureOpened = await card.locator("details").evaluate(d => d.open);
    await card.locator("summary").focus();
    await other.locator("#message-input").fill("background traffic");
    await other.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#message-list")?.textContent.includes("background traffic"));
    obs.disclosureStayed = await card.locator("details").evaluate(d => d.open);
    obs.focusStayed = await page.evaluate(() => document.activeElement?.tagName === "SUMMARY");
    await otherContext.close();
  }
  await context.close();
  server.closeStreams(); server.closeAllConnections();
  await new Promise(r => server.close(r));
  return obs;
}

function checkGreenUi(obs) {
  check("no onerror handler fired (displayName)", obs.pwned1);
  check("no onload handler fired (body svg)", obs.pwned2);
  check("no script executed (body)", obs.pwned3);
  check("no injected img[src=x] node", obs.imgCount === 0, `count=${obs.imgCount}`);
  check("hostile displayName rendered as text", obs.displayNameAsText);
}

function checkDisclosure(obs) {
  check("disclosure opened", obs.disclosureOpened);
  check("disclosure stayed open across background update", obs.disclosureStayed);
  check("focus stayed on the disclosure summary", obs.focusStayed);
  check("no page errors", obs.errors.length === 0, obs.errors.join("; "));
}

const appBefore = readFileSync(appJsPath);
let mutantDir;
try {
  if (mutantOnly) {
    const mutant = isolateMutantAssets();
    mutantDir = mutant.dir;
    const obs = await observeUi(mutant.assetRoot, true);
    checkGreenUi(obs);
    checkDisclosure(obs);
    console.log("     [mutant] isolated esc-identity assets; green XSS/DOM assertions must fail");
  } else {
    const green = await observeUi(undefined, true);
    checkGreenUi(green);
    checkDisclosure(green);
    const mutant = isolateMutantAssets();
    mutantDir = mutant.dir;
    const mutantApp = readFileSync(join(mutant.dir, "src/app.js"), "utf8");
    check("isolated mutant replaced esc() with identity", mutantApp.includes(IDENTITY) && !mutantApp.includes(ESC));
    const red = await observeUi(mutant.assetRoot, false);
    check("isolated mutant injects img[src=x] (esc-removal teeth)", red.imgCount > 0, `count=${red.imgCount}`);
    check("isolated mutant does not render hostile displayName as text", red.displayNameAsText === false);
    check("production src/app.js unchanged", Buffer.from(readFileSync(appJsPath)).equals(Buffer.from(appBefore)));
  }
} finally {
  await browser.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  if (mutantDir) rmSync(mutantDir, { recursive: true, force: true });
}
console.log(`\n${pass} pass / ${failCount} fail`);
process.exit(failCount ? 1 : 0);
