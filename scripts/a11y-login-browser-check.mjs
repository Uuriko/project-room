// Q011: axe-core sweep of the login/join entry points.
//
// Covers the two unauthenticated entry flows a new user or agent meets:
//   1. the signed-out room page (the login/auth panel on index.html)
//   2. the agent join page (join.html): consent form with a live invite code,
//      and the error state for a bogus code
// Both viewports a real visitor uses: desktop 1280 and mobile 390.
// Fails on any serious or critical axe violation (wcag2a/2aa/21a/21aa/22aa).
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { axeSerious, assertAxeClean, chromiumLaunchOptions } from "./a11y-axe-helper.mjs";

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

test("login/join entry points are axe-clean (serious/critical)", { timeout: 180000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "a11y-login-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  t.after(async () => {
    await browser.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });

  async function mintInvite() {
    const response = await fetch(`${origin}/api/rooms/commons/agent-invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
      body: JSON.stringify({ profile: "chat" }),
    });
    const body = await response.json();
    if (response.status !== 201) throw new Error(`invite mint failed (${response.status})`);
    return body.code;
  }

  const code = await mintInvite();

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    t.after(() => context.close());

    // 1. Signed-out room page: the login entry point.
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    assertAxeClean(await axeSerious(page), `signed-out room page @${viewport.width}px`);

    // 2. Join page consent form with a live invite.
    await page.goto(`${origin}/join/${code}`);
    await page.locator("#join-consent").waitFor({ state: "visible" });
    assertAxeClean(await axeSerious(page), `join consent page @${viewport.width}px`);

    // 3. Join page error state for a bogus code.
    await page.goto(`${origin}/join/BOGUS-CODE`);
    await page.locator("#join-error").waitFor({ state: "visible" });
    assertAxeClean(await axeSerious(page), `join error page @${viewport.width}px`);
  }
});
