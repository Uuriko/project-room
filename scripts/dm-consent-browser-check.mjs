// DM consent UI journey: request → pending → approve → DM posts → revoke →
// block → gate errors → unblock, plus a forced 500's visible notice and the
// logged-out public face staying consent-control-free. Real browser + local
// HTTP service; identities and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { fillAccessKey } from "./auth-signin.mjs";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

test("DM consent browser journey: request, approve, revoke, block, errors", { timeout: 240000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-dm-consent-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (const [id, name] of [["alice", "Alice"], ["bob", "Bob"]]) {
    store.command(owner, "commons", command("member.added", {
      memberId: id, displayName: name, kind: "human", permissions: []
    }));
  }
  const aliceKey = store.issueAccessKey("commons", "alice");
  const bobKey = store.issueAccessKey("commons", "bob");
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true,
    // Newer Chromium builds gate loopback navigation behind Local Network
    // Access checks; the fixture server is always 127.0.0.1.
    args: ["--disable-features=LocalNetworkAccessChecks"],
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });

  const signIn = async key => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error?.message ?? error)));
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await fillAccessKey(page, key);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    return { page, errors };
  };
  const openPeople = async page => {
    if (!(await page.locator("#people-panel").evaluate(node => node.open))) {
      await page.locator("#people-panel > summary").click();
    }
    await page.locator("#presence-list").waitFor();
  };
  const consentSection = (page, memberId) =>
    page.locator(`#presence-list .presence-member[data-member-record-id="${memberId}"] details.dm-consent`);
  // #message-to-select lives in #composer-toolbar, which stays hidden until a
  // recipient is chosen — set it the way disclosure-check.mjs does instead of
  // selectOption, which requires the select to be visible.
  const selectRecipient = (page, value) =>
    page.locator("#message-to-select").evaluate((el, v) => {
      el.value = v; el.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);

  // --- Alice requests to message Bob; the pending state is visible. ---
  const a = await signIn(aliceKey);
  await openPeople(a.page);
  const aliceBob = consentSection(a.page, "bob");
  await aliceBob.locator("summary").click();
  await aliceBob.getByRole("button", { name: "Request to message", exact: true }).click();
  await aliceBob.getByText("Request pending").waitFor();
  assert.match(await a.page.locator("#status.visible").textContent(), /DM request sent to Bob/);

  // --- The consent gate refuses the DM in the composer, draft kept. ---
  await selectRecipient(a.page, "bob");
  await a.page.locator("#message-input").fill("hello bob, consent-gated");
  await a.page.locator("#message-form button[type=submit]").click();
  const composerError = a.page.locator("#composer-status.visible.error");
  await composerError.waitFor();
  assert.match(await composerError.textContent(), /Bob hasn't approved DMs from you yet/);
  assert.equal(await a.page.locator("#message-input").inputValue(), "hello bob, consent-gated",
    "the refused draft stays in the composer");

  // --- Bob's People panel carries the incoming request; he approves. ---
  const b = await signIn(bobKey);
  await openPeople(b.page);
  const inbox = b.page.locator(".dm-requests");
  await inbox.getByText("Direct message requests (1)").waitFor();
  assert.match(await inbox.textContent(), /Alice/);
  await inbox.getByRole("button", { name: "Approve", exact: true }).click();
  await b.page.locator("#status.visible").getByText(/Alice can now message you directly/).waitFor();
  assert.equal(await b.page.locator(".dm-requests").count(), 0, "the inbox clears after a decision");

  // --- Bob's member row for Alice reflects the approval; Alice can now DM. ---
  const bobAlice = consentSection(b.page, "alice");
  await bobAlice.locator("summary").click();
  assert.match(await bobAlice.textContent(), /Alice can message you/);

  // --- Alice's pending becomes approved ("Bob approved your request"); the DM posts. ---
  await a.page.reload();
  await a.page.locator("#main").waitFor({ state: "visible" });
  await openPeople(a.page);
  const aliceBob2 = consentSection(a.page, "bob");
  await aliceBob2.locator("summary").click();
  await aliceBob2.getByText("Bob approved your request — you can message them directly.").waitFor();
  await selectRecipient(a.page, "bob");
  assert.equal(await a.page.locator("#message-to-select").inputValue(), "bob",
    "the recipient select took the evaluate-set value before sending");
  await a.page.locator("#message-input").fill("hello bob, approved");
  await a.page.locator("#message-form button[type=submit]").click();
  await a.page.locator("#message-input").waitFor({ state: "visible" });
  assert.equal(await a.page.locator("#message-input").inputValue(), "",
    "an approved DM sends and clears the composer");
  assert.equal(await a.page.locator("#composer-status.visible.error").count(), 0);

  // --- Alice revokes; she is back to requesting. ---
  await aliceBob2.getByRole("button", { name: "Revoke my consent", exact: true }).click();
  await aliceBob2.getByText("Request again").waitFor();

  // --- Bob proactively blocks Alice; her row says so and the gate refuses. ---
  const bobAlice2 = consentSection(b.page, "alice");
  await bobAlice2.locator("summary").click();
  await bobAlice2.getByRole("button", { name: "Block", exact: true }).click();
  await b.page.locator("#status.visible").getByText(/Alice blocked/).waitFor();
  assert.equal(await consentSection(b.page, "alice").getByRole("button", { name: "Unblock", exact: true }).count(), 1);
  await a.page.reload();
  await a.page.locator("#main").waitFor({ state: "visible" });
  await openPeople(a.page);
  const aliceBob3 = consentSection(a.page, "bob");
  await aliceBob3.locator("summary").click();
  await aliceBob3.getByText("Bob isn't accepting DM requests from you").waitFor();
  // --- Bob unblocks; Alice can ask again. ---
  await bobAlice2.getByRole("button", { name: "Unblock", exact: true }).click();
  await b.page.locator("#status.visible").getByText(/Alice unblocked/).waitFor();
  await a.page.reload();
  await a.page.locator("#main").waitFor({ state: "visible" });
  await openPeople(a.page);
  const aliceBob4 = consentSection(a.page, "bob");
  await aliceBob4.locator("summary").click();
  await aliceBob4.getByRole("button", { name: "Request again", exact: true }).waitFor();

  // --- A 500 on the consent API surfaces as a visible error, not a spinner. ---
  await a.page.route("**/dm-consents", route => route.fulfill({
    status: 500, contentType: "application/json",
    body: JSON.stringify({ error: { code: "dm_unexpected", message: "boom" } })
  }));
  await aliceBob4.getByRole("button", { name: "Request again", exact: true }).click();
  const serverError = a.page.locator("#status.visible.error");
  await serverError.waitFor();
  assert.match(await serverError.textContent(), /boom/, "the 500's message is visible, not swallowed");
  await a.page.unroute("**/dm-consents");

  // --- Reject path: Alice requests again, Bob rejects. ---
  await aliceBob4.getByRole("button", { name: "Request again", exact: true }).click();
  await aliceBob4.getByText("Request pending").waitFor();
  await b.page.reload();
  await b.page.locator("#main").waitFor({ state: "visible" });
  await openPeople(b.page);
  const inbox2 = b.page.locator(".dm-requests");
  await inbox2.getByText("Direct message requests (1)").waitFor();
  await inbox2.getByRole("button", { name: "Reject", exact: true }).click();
  await b.page.locator("#status.visible").getByText(/Declined Alice's DM request/).waitFor();
  assert.equal(await b.page.locator(".dm-requests").count(), 0);

  // --- Logged-out public face: no consent controls, still read-only. ---
  const enabled = await (await fetch(`${origin}/api/rooms/commons/public-face`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${owner}` },
    body: JSON.stringify({ enabled: true })
  })).json();
  assert.ok(/^pub1\./.test(enabled.publicCode), "public code mints");
  const face = await (await fetch(`${origin}/p/${enabled.publicCode}`)).text();
  assert.ok(!/dm-consent/.test(face), "the public face carries no consent controls");
  assert.ok(!/message-form/.test(face), "the public face stays read-only");

  assert.equal(a.errors.join("\n"), "", "alice page had no JS errors");
  assert.equal(b.errors.join("\n"), "", "bob page had no JS errors");
});
