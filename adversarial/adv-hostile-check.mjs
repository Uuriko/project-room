// Pass 27: hostile-id / hostile-text injection matrix. MODE=mutant runs against an esc-less
// app.js and MUST fail (teeth proof); default run MUST pass.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

let pass = 0, failCount = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { failCount++; console.log(`FAIL ${name} ${detail}`); }
};

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

const server = createRoomServer({ store, streamInterval: 60 });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const otherContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const other = await otherContext.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));

const login = async (p, key) => {
  await p.goto(origin);
  await p.locator("#auth-panel").waitFor({ state: "visible" });
  await p.locator("#access-key").fill(key);
  await p.getByRole("button", { name: "Enter room", exact: true }).click();
  await p.locator("#main").waitFor({ state: "visible" });
};
await login(page, owner);
await login(other, hostile);

// 3. No injection executed, hostile strings rendered as inert text.
check("no onerror handler fired (displayName)", await page.evaluate(() => window.__pwned1 === undefined));
check("no onload handler fired (body svg)", await page.evaluate(() => window.__pwned2 === undefined));
check("no script executed (body)", await page.evaluate(() => window.__pwned3 === undefined));
check("no injected img[src=x] node", await page.locator('img[src="x"]').count() === 0);
check("hostile displayName rendered as text", await page.locator("#presence-list").innerText().then(t => t.includes('<img src=x onerror="window.__pwned1=1">')));

// 4. Disclosure + focus restore survive a background update, hostile member's own card.
const card = page.locator('[data-disclosure-host="hostile"]');
await card.locator('summary').click();
check("disclosure opened", await card.locator('details').evaluate(d => d.open));
await card.locator('summary').focus();
await other.locator("#message-input").fill("background traffic");
await other.getByRole("button", { name: "Send", exact: true }).click();
await page.waitForFunction(() => document.querySelector("#message-list")?.textContent.includes("background traffic"));
check("disclosure stayed open across background update", await card.locator('details').evaluate(d => d.open));
check("focus stayed on the disclosure summary", await page.evaluate(() => document.activeElement?.tagName === "SUMMARY"));
check("no page errors", errors.length === 0, errors.join("; "));

await browser.close();
server.closeStreams(); server.closeAllConnections();
await new Promise(r => server.close(r)); store.close(); rmSync(directory, { recursive: true, force: true });
console.log(`\n${pass} pass / ${failCount} fail`);
process.exit(failCount ? 1 : 0);
