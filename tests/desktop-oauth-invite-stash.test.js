// WAVE-500 guild 1 (auth & sign-in), worker 19: invite + OAuth context.
//
// The desktop (native-app) OAuth auto-start must stash a live invitation
// exactly like the three OAuth buttons do. The #invite/ fragment never
// reaches the server, so without the stash a desktop invitee who opens
// #invite/<token> loses the invitation across the Google/GitHub round-trip:
// the callback lands on /?room= or /?account=1 with no hash, the boot
// restore finds nothing, and the dialog never re-opens.
//
// This pins the wiring in src/app.js: every client navigation to an OAuth
// start route must be preceded by stashInviteForOAuth().
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "src", "app.js"), "utf8");
const htmlSrc = readFileSync(join(root, "index.html"), "utf8");

test("every OAuth entry point stashes the invitation before navigating", () => {
  // 1. Main sign-in panel: "Continue with Google" anchor.
  assert.ok(htmlSrc.includes('id="google-signin"'), "index.html keeps the #google-signin button");
  assert.match(
    appSrc,
    /\$\("#google-signin"\)[\s\S]{0,300}?stashInviteForOAuth/,
    "#google-signin click stashes the invitation before the OAuth navigation"
  );
  // 2. Invitation dialog: "Continue with Google" anchor.
  assert.ok(htmlSrc.includes('id="invitation-google"'), "index.html keeps the #invitation-google button");
  assert.match(
    appSrc,
    /\$\("#invitation-google"\)\.addEventListener\("click",[\s\S]*?stashInviteForOAuth\(\)/,
    "#invitation-google click stashes the invitation before the OAuth navigation"
  );
  // 3. Share-link join dialog: Google button, wired through onOAuthStart.
  assert.ok(htmlSrc.includes('id="join-account-google"'), "index.html keeps the #join-account-google button");
  assert.ok(
    appSrc.includes("onOAuthStart: stashInviteForOAuth"),
    "the share-links install wires onOAuthStart to the invitation stash"
  );
  // 4. Desktop (native-app) auto-start: a scripted location.assign to the
  // provider start route. This is the one that used to skip the stash.
  const marker = "if (initialDesktopProvider && !initialGoogleFailed && !initialGitHubFailed) {";
  const at = appSrc.indexOf(marker);
  assert.ok(at !== -1, "the desktop OAuth auto-start block exists in src/app.js");
  const block = appSrc.slice(at, at + 600);
  const stashAt = block.indexOf("stashInviteForOAuth()");
  const navAt = block.indexOf("location.assign");
  assert.ok(navAt !== -1, "the desktop auto-start navigates to the provider start route");
  assert.ok(stashAt !== -1, "the desktop OAuth auto-start stashes the invitation before navigating");
  assert.ok(stashAt < navAt, "the stash happens before the navigation, not after");
});
