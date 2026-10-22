// Login-wall tab order (browser-runner finding, 2026-10-13): the terms
// notice sat FIRST in the DOM inside #signin-methods while CSS flex/grid
// ordering painted it last, so keyboard users tabbed through the Terms /
// Privacy links before ever reaching a sign-in control. Contract: DOM
// order IS the visual order — sign-in controls first, consent last, and
// no CSS `order` on the notice re-sorting it. Plus: the wall carries a
// functional exit for the other human door — "Join a room"
// routes to the join page (not product education, which stays outside
// sign-in per tests/human-onboarding-doors.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function sliceBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = text.indexOf(endMarker, start);
  assert.ok(end > start, `missing ${endMarker} after ${startMarker}`);
  return text.slice(start, end);
}

test("terms notice is last in DOM order inside the sign-in methods", () => {
  const methods = sliceBetween(html, 'id="signin-methods"', 'id="email-auth-step"');
  const google = methods.indexOf('id="google-signin"');
  const controller = methods.indexOf('id="signin-controller"');
  const terms = methods.indexOf('id="terms-notice"');
  assert.ok(google >= 0 && controller > google, "Google then the email/password controller");
  assert.ok(terms > controller, "consent notice follows the sign-in controls in the DOM");
  assert.match(methods, /id="terms-notice">By continuing you agree to the <a href="\/terms">Terms<\/a> and <a href="\/privacy">Privacy Policy<\/a>\./, "the notice itself is unchanged");
});

test("no CSS order re-sorts the terms notice", () => {
  const rule = css.match(/#terms-notice\s*\{[^}]*\}/)?.[0];
  assert.ok(rule, "the #terms-notice rule still exists (typography/margins)");
  assert.ok(!/order\s*:/.test(rule), "visual order must come from the DOM, not flex/grid order");
});

test("the wall offers room joining beside agent sign-in", () => {
  const routes = sliceBetween(html, 'id="signin-entry-routes"', '</section>');
  assert.match(routes, /<a id="join-code-link" class="text-button" href="\/join">Join a room<\/a>/);
  // Agent sign-in is a link to its own page now (decision #37), not a
  // button opening an in-wall step.
  assert.match(routes, /<a id="agent-signin-button" class="text-button" href="\/agent-signin">Agent sign in<\/a>/);
  assert.ok(routes.indexOf('id="join-code-link"') < routes.indexOf('id="agent-signin-button"'), "the human route is listed before the agent route");
  assert.ok(!html.includes('id="agent-auth-step"'), "the in-wall agent step is gone");
});
