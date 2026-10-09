import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// M-04 mobile DM journey: the friend-DM dialog (#friend-dm-dialog) is the
// human DM surface. On a 390px phone the thread must land on the latest
// message, own messages must be visually distinct, and the compose box must
// behave like the main composer (Enter to send on desktop keyboards, a "send"
// return key on touch keyboards). These are static source checks in the style
// of tests/index-html-structure.test.js: the browser behavior itself can't
// run here, but the wiring can be asserted cheaply.

const styles = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("../src/app.js", import.meta.url)), "utf8");
const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

function ruleFor(selector) {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*{([^}]*)}`, "g");
  return [...styles.matchAll(pattern)].map(m => m[1]).join("\n");
}

test("friend-DM thread lands on the latest message after load and after send", () => {
  // loadFriendThread renders into #friend-dm-list; without an explicit
  // scroll the 16rem window shows the oldest messages on a phone.
  const loadBlock = app.slice(app.indexOf("async function loadFriendThread"), app.indexOf("function openFriendThread"));
  assert.ok(loadBlock.includes("friend-dm-list"), "loadFriendThread renders #friend-dm-list");
  assert.ok(/scrollTop\s*=\s*.*scrollHeight/.test(loadBlock),
    "loadFriendThread scrolls the DM list to the bottom after rendering");
});

test("own DM messages are visually distinct from the peer's", () => {
  const mine = ruleFor(".friend-dm-message.mine");
  assert.ok(mine, ".friend-dm-message.mine has a CSS rule (the class existed with zero styling)");
  assert.ok(/justify-self\s*:\s*end|margin-inline-start\s*:\s*auto|align-self\s*:\s*(end|flex-end)/.test(mine),
    "own messages are pushed to the trailing edge like a chat bubble");
  assert.ok(/background\s*:/.test(mine), "own messages carry a distinct background tint");
});

test("friend-DM thread list is viewport-bounded, not a fixed rem height", () => {
  const list = ruleFor(".friend-dm-list");
  assert.ok(list, ".friend-dm-list rule exists");
  assert.ok(/min\s*\(/.test(list) && /dvh/.test(list),
    "list max-height is min(<cap>, <dvh>) so the compose box stays reachable with the keyboard open");
});

test("friend-DM compose has the same Enter-to-send keyboard behavior as the main composer", () => {
  // The handler is attached as $("#friend-dm-input").addEventListener("keydown", ...)
  // and must route through the shared sendsOnEnter helper with the
  // touch-keyboard media query, like the main composer does.
  assert.ok(/friend-dm-input"\)\.addEventListener\("keydown"[\s\S]{0,800}sendsOnEnter\(/.test(app),
    "DM compose keydown goes through sendsOnEnter");
  assert.ok(/sendsOnEnter\(e,\s*touchKeyboard\.matches\)/.test(
    app.slice(app.indexOf('friend-dm-input").addEventListener("keydown"'))),
    "DM compose passes the touch-keyboard media query to sendsOnEnter");
  assert.ok(/friend-dm-input[\s\S]{0,4000}enterKeyHint/.test(app),
    "DM compose sets enterKeyHint so touch keyboards show a send key");
});

test("friend-DM dialog carries a keyboard hint like the main composer", () => {
  assert.ok(html.includes('id="friend-dm-hint"'), "index.html has a #friend-dm-hint element");
  assert.ok(app.includes("friend-dm-hint"), "app.js updates #friend-dm-hint");
});
