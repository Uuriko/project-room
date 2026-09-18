// Browser coverage for the account settings UI (slice 7, RC-2026-09-17-016):
// the session menu opens Sign-in & security, the linked methods render with
// honest provider-unconfigured states, disable/enable/remove work through
// the real UI (including the last-active-method guard), and recovery codes
// are generated and shown once. Boots a real server against an
// acceptance-fixture store over loopback; no network calls.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { hashPassword } from "../src/password-auth.mjs";
import { fillAccessKey } from "./auth-signin.mjs";

async function expandSignInOptions(page) {
  const more = page.locator("#signin-more");
  const extra = page.locator("#signin-extra");
  if (await more.count() && await extra.isHidden()) await more.click();
  await extra.waitFor({ state: "visible" });
}
