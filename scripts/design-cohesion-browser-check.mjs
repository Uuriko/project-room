// Computed-style regression for the shared tokens and the regrouped Settings
// dialog. The repo has no pixel-snapshot library; screenshots are evidence
// and these assertions are the check.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { EVENT_TYPES as T } from "../src/events.js";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openSettings } from "./room-chrome.mjs";
import { ROOM_ENTRY_HTML, publicRoomDoorHtml } from "../deploy/room-entry.mjs";
import { contrastRatio } from "../src/design-tokens.js";

const hex = rgb => "#" + rgb.match(/\d+/g).slice(0, 3).map(n => Number(n).toString(16).padStart(2, "0")).join("");

const shots = "test-results/design";

async function boot(t) {
  mkdirSync(shots, { recursive: true });
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    await browser.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return { page, origin, browser, key: f.keys.owner, fixture: f };
}

test("shared tokens, focus, and settings sections render together", { timeout: 60000 }, async t => {
  const { page, origin, browser, key } = await boot(t);
  await page.goto(origin + "/");
  await page.locator("#auth-title").waitFor();
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  assert.equal(bg, "#202127");
  const hint = await page.locator("#auth-hero > .form-hint").evaluate(node => {
    const color = getComputedStyle(node).color;
    const background = getComputedStyle(node.parentElement).backgroundColor;
    return { color, background };
  });
  const hintRatio = contrastRatio(hex(hint.color), hex(hint.background));
  assert.ok(hintRatio >= 4.5, `#auth-hero hint ${hint.color} on ${hint.background} is ${hintRatio.toFixed(2)}:1`);
  assert.equal(hex(hint.color), "#aaaab7");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  assert.notEqual(outline.style, "none");
  assert.notEqual(outline.width, "0px");
  await page.screenshot({ path: `${shots}/after-auth.png`, fullPage: true });

  await signInFixture(page, key);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.screenshot({ path: `${shots}/after-room.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/after-room-mobile.png` });
  await page.setViewportSize({ width: 1280, height: 900 });

  await openSettings(page);
  const dialog = page.locator("#settings-dialog");
  for (const title of ["Room", "Agents & connections", "Billing / plan", "Advanced"]) {
    await dialog.locator(".settings-group-title", { hasText: title }).waitFor();
  }
  const resultsParent = await page.locator("#results-panel").evaluate(node => node.parentElement.id);
  assert.equal(resultsParent, "settings-dialog");
  await dialog.screenshot({ path: `${shots}/after-settings.png` });

  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  const light = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  assert.equal(light, "#f4f3f8");
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });

  await page.goto(origin + "/about");
  await page.locator("h1").waitFor();
  const aboutBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(aboutBg, "rgb(32, 33, 39)");
  await page.screenshot({ path: `${shots}/after-about.png`, fullPage: true });

  await page.goto(origin + "/offers");
  await page.locator("body").waitFor();
  const offersBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(offersBg, "rgb(32, 33, 39)");
  await page.screenshot({ path: `${shots}/after-offers.png`, fullPage: true });

  const door = await browser.newPage();
  await door.setContent(ROOM_ENTRY_HTML, { waitUntil: "load" });
  await door.screenshot({ path: `${shots}/after-door-demigod.png`, fullPage: true });
  await door.setContent(publicRoomDoorHtml(), { waitUntil: "load" });
  const doorBg = await door.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(doorBg, "rgb(32, 33, 39)");
  await door.screenshot({ path: `${shots}/after-door-public.png`, fullPage: true });
  await door.close();
});

// This is the component contrast owner: token declarations alone cannot catch
// a component retaining a fixed dark-theme foreground on a light surface.
// Read rendered layers, including mention/pinned tints, rather than assuming
// every component is painted directly on the body background.
async function renderedContrast(locator) {
  await locator.waitFor({ state: "visible" });
  const sample = await locator.evaluate(node => {
    const layers = [];
    for (let element = node; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      layers.unshift({ background: style.backgroundColor, image: style.backgroundImage, opacity: style.opacity });
    }
    return { foreground: getComputedStyle(node).color, layers };
  });
  const rgba = color => {
    assert.match(color, /^rgba?\(/, `Unsupported computed color: ${color}`);
    const values = color.match(/[\d.]+/g).map(Number);
    return [...values.slice(0, 3), values[3] ?? 1];
  };
  const over = (front, back) => front.slice(0, 3).map((value, i) => value * front[3] + back[i] * (1 - front[3]));
  let background = [255, 255, 255];
  for (const layer of sample.layers) {
    assert.equal(layer.image, "none", "Contrast fixture needs a solid or transparent background");
    assert.equal(Number(layer.opacity), 1, "Contrast fixture must not hide translucent group opacity");
    background = over(rgba(layer.background), background);
  }
  const foreground = over(rgba(sample.foreground), background);
  // Independent WCAG sRGB computation; do not derive the expected component
  // value from the production token helper being exercised above.
  const luminance = color => color.map(value => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  const light = luminance(foreground), dark = luminance(background);
  return { ...sample, background, ratio: (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05) };
}

test("message, pinned and work-fact text stays readable through light/dark changes", { timeout: 120000 }, async t => {
  const { page, origin, key, fixture } = await boot(t);
  const send = (actor, type, data) => fixture.store.command(fixture.keys[actor], "commons", { id: randomUUID(), type, data });
  send("owner", T.MESSAGE_POSTED, { messageId: "contrast-plain", body: "Readable plain message with an ordinary text value." });
  send("owner", T.MESSAGE_POSTED, { messageId: "contrast-grouped", body: "The next grouped message keeps the same readable hierarchy." });
  const ownerName = fixture.store.room("commons").state.members.owner.displayName;
  send("producer", T.MESSAGE_POSTED, { messageId: "contrast-mention", body: `@${ownerName} please review this highlighted message.` });
  send("reviewer", T.MESSAGE_POSTED, { messageId: "contrast-deleted", body: "Synthetic message removed from the conversation." });
  send("owner", T.MESSAGE_DELETED, { messageId: "contrast-deleted", expectedMessageRevision: 0, reason: "Synthetic cleanup" });
  send("owner", T.MESSAGE_PINNED, { messageId: "contrast-plain" });
  send("guest", T.MESSAGE_POSTED, { messageId: "contrast-muted", body: "Synthetic message hidden by the viewer's mute preference." });
  send("owner", T.MEMBER_MUTE_SET, { memberId: "guest", muted: true });
  send("owner", T.MESSAGE_POSTED, { messageId: "contrast-draft", body: "Synthetic draft for review.",
    workItemId: "test-handoff", packetId: "contrast-packet", basisRevision: 0 });
  await page.goto(origin + "/");
  await signInFixture(page, key);
  const row = id => page.locator(`#message-list [data-message-record-id="${id}"]`);
  const card = page.locator('[data-work-record-id="test-handoff"]');
  const summary = card.locator(".work-details > summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  assert.equal(await card.locator(".work-details").evaluate(node => node.open), true);
  assert.equal(await summary.evaluate(node => node === document.activeElement), true, "Keyboard disclosure preserves focus");
  await page.locator("#pinned-panel > summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#pinned-panel").evaluate(node => node.open), true);
  assert.equal(await row("contrast-grouped").evaluate(node => node.classList.contains("grouped")), true);
  assert.equal(await row("contrast-mention").evaluate(node => node.classList.contains("mentioned")), true);

  const samples = [
    ["plain", row("contrast-plain").locator(".message-body")],
    ["grouped", row("contrast-grouped").locator(".message-body")],
    ["mentioned", row("contrast-mention").locator(".message-body")],
    ["deleted", row("contrast-deleted").locator(".message-tombstone")],
    ["muted", row("contrast-muted").locator(".message-muted")],
    ["draft-metadata", row("contrast-draft").locator(".draft-feedback > .form-hint")],
    ["pinned", page.locator("#pinned-list .pinned-body").first()],
    ["work-fact", card.locator(".work-details > .work-facts dd").first()],
  ];
  const evidence = [];
  // This member-only fixture has no account appearance form. Exercise the
  // same document root used by applyTheme; stored/system preference behavior
  // has its primary owner in account-settings-ui.test.js.
  for (const [pass, theme] of ["light", "dark", "light"].entries()) {
    await page.evaluate(mode => {
      if (mode === "light") document.documentElement.dataset.theme = mode;
      else delete document.documentElement.dataset.theme;
    }, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const rootTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? "dark");
      assert.equal(rootTheme, theme);
      for (const [name, locator] of samples) {
        await locator.scrollIntoViewIfNeeded();
        const measured = await renderedContrast(locator);
        evidence.push({ pass, theme, width, name, ...measured });
      }
      await row("contrast-plain").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/contrast-${pass}-${theme}-${width}-messages.png` });
      await row("contrast-draft").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/contrast-${pass}-${theme}-${width}-metadata.png` });
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/contrast-${pass}-${theme}-${width}-work.png` });
      await page.locator("#pinned-panel").scrollIntoViewIfNeeded();
      await page.locator("#pinned-panel").screenshot({ path: `${shots}/contrast-${pass}-${theme}-${width}-pinned.png` });
    }
  }
  writeFileSync(`${shots}/component-contrast.json`, JSON.stringify(evidence, null, 2) + "\n");
  const failures = evidence.filter(sample => sample.ratio < 4.5);
  assert.deepEqual(failures.map(({ theme, width, name, ratio }) => `${theme}/${width}/${name}: ${ratio}:1`), [], "Visible component text must meet unrounded 4.5:1 in both themes");
  for (const sample of evidence.filter(sample => sample.theme === "dark")) {
    assert.equal(sample.foreground, sample.name === "work-fact" ? "rgb(216, 222, 232)" : "rgb(223, 229, 237)", "Existing dark message/value palette is unchanged");
  }
  for (const sample of evidence.filter(sample => sample.theme === "light" && ["deleted", "muted", "draft-metadata"].includes(sample.name))) {
    assert.equal(sample.foreground, "rgb(92, 91, 106)", "Secondary message state retains the light muted hierarchy");
  }
  const axe = await new AxeBuilder({ page })
    .include("#pinned-list .pinned-body")
    .include('[data-work-record-id="test-handoff"] .work-details > .work-facts')
    .withRules(["color-contrast"]).analyze();
  writeFileSync(`${shots}/component-axe.json`, JSON.stringify(axe, null, 2) + "\n");
  assert.deepEqual(axe.violations, [], "Scoped visible pinned/work-fact contrast has no axe violations");
});
