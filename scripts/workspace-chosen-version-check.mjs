// Exercise the shipped UI modules without a live Room, agent, or external network.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: '<nav></nav>' });
    if (/^\/(src|strings)\/[a-z-]+\.js$/.test(path)) return route.fulfill({
      contentType: "text/javascript", body: await readFile(new URL(".." + path, import.meta.url)),
    });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://localhost/");
  await page.evaluate(async () => {
    const { installWorkspacePreviews } = await import("/src/workspace-previews-ui.js");
    const items = ["a", "b"].map(c => ({ id: c.repeat(32), revision: 1, publisherId: c, head: c.repeat(40),
      base: "0".repeat(40), digest: c.repeat(64), patchDigest: c.repeat(64), title: "Version " + c }));
    window.items = items;
    const client = { path: path => path, session: { roomId: "commons" }, roomRead: async path => {
      const query = new URL(path, location.href).searchParams;
      if (query.has("changes")) return { changes: { files: [] } };
      if (query.has("id")) return { item: items.find(item => item.id === query.get("id")) };
      return { items: structuredClone(items) };
    }};
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw Error("manual"); } } });
    window.workspace = installWorkspacePreviews({ client, toolbar: document.querySelector("nav"), memberLabel: id => id,
      captureThreadDraft: () => ({
        discussion: () => ({ link: "http://localhost/?room=commons#pr-record/message/design",
          messages: [{ author: "Designer", excerpt: "Keep the navigation." }] }),
        append: (link, note) => { window.draft = { link, note }; return true; },
      }) });
  });
  async function compare() {
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.locator("[data-preview-id]").first().click();
    await page.getByRole("tab", { name: "Changes" }).click();
    await page.locator("[data-workspace-compare]").selectOption("b".repeat(32));
    await page.locator("[data-workspace-peer] button").first().waitFor();
  }
  for (const side of ["a", "b"]) {
    await compare();
    await page.getByRole("button", { name: "Continue this version: Version " + side }).click();
    await page.getByRole("heading", { name: "Version " + side, exact: true }).first().waitFor();
    const note = page.getByLabel("Instruction for this version");
    await note.fill("Use the existing navigation.");
    await page.getByRole("button", { name: "Copy for agent" }).click();
    const fallback = page.locator("[data-workspace-link-fallback]");
    await fallback.waitFor();
    const packet = await fallback.inputValue();
    assert.ok(packet.includes(side.repeat(40)) && packet.includes("Use the existing navigation.") && packet.includes("#pr-record/message/design"));
    await page.getByRole("button", { name: "Add to thread draft" }).click();
    await page.locator("dialog").waitFor({ state: "hidden" });
    const draft = await page.evaluate(() => window.draft);
    assert.ok(draft.link.includes(side.repeat(32)) && draft.note === "Use the existing navigation.");
  }
  const returned = await page.evaluate(() => {
    const source = { discussion: () => ({ link: "http://localhost/?room=commons#pr-record/message/revision",
      messages: [{ author: "Reviewer", excerpt: "Here is the revision." }] }),
      append: (link, note) => { window.followUp = { link, note }; return true; } };
    return window.workspace.openLink(new URL(window.draft.link).hash, source);
  });
  assert.equal(returned, true);
  assert.equal(await page.getByText("Open full discussion").getAttribute("href"),
    "http://localhost/?room=commons#pr-record/message/revision");
  await page.getByLabel("Instruction for this version").fill("Keep the revised navigation.");
  await page.getByRole("button", { name: "Add to thread draft" }).click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.followUp),
    { link: await page.evaluate(() => window.draft.link), note: "Keep the revised navigation." });
  await compare();
  await page.evaluate(() => { window.items[1].revision++; });
  await page.getByRole("button", { name: "Continue this version: Version b" }).click();
  await page.getByText(/This preview revision changed/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Copy for agent" }).count(), 0);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => { window.items[1].recipientId = "friend"; });
  await compare();
  await page.getByRole("button", { name: "Continue this version: Version b" }).click();
  await page.getByLabel("Instruction for this version").waitFor();
  assert.equal(await page.getByRole("button", { name: "Add to thread draft" }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("Both comparison columns, manual copy, return drafts, stale replacement and directed publication passed.");
} finally { await browser.close(); }
