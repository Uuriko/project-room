// PRODUCT-200 M-03 — mobile invite-redeem journey (390/375px).
//
// Fail-first tests for the mobile invite-redeem frictions found by walking
// invite link -> redeem -> identity -> first room on phone viewports:
//
// F1. The join POST had no timeout: a stalled network left "Joining…"
//     on screen forever with the button disabled and no watchdog covering
//     that state (the preview fetch has a 10s bound; the loader watchdog
//     only watches the loading card).
// F2. Double-submit race: the submit button is disabled during the POST,
//     but an Enter-key submit on the name input re-fires the handler while
//     the first POST is still in flight (two redeems, second dies with
//     invite_already_used).
// F3. Consent-screen autofocus pops the soft keyboard over the invite
//     details (room, inviter, permissions, expiry) on touch devices before
//     the human reads them — focus should be fine-pointer only.
// F4. A bare invite code (texted as "RM-XXXX", no link) is a dead end:
//     /join with no code says "ask a room owner for an invite link" with
//     nowhere to paste the code. The no-invite error screen gets a code
//     entry that navigates to /join/<CODE>.
// F5. Join CTAs at .78rem (~12.5px) on the stranger's most critical screen:
//     join-page-scoped 1rem floor for buttons.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";

const repoRoot = pathJoin(dirname(fileURLToPath(import.meta.url)), "..");

// --- F1: join POST timeout -----------------------------------------------

test("M-03 F1: apiFetch is exported and bounds a hanging join POST", async () => {
  const { apiFetch, JOIN_TIMEOUT_MS } = await import("../src/join.js");
  assert.equal(typeof apiFetch, "function", "apiFetch must be importable");
  assert.ok(Number.isFinite(JOIN_TIMEOUT_MS) && JOIN_TIMEOUT_MS > 0, "JOIN_TIMEOUT_MS is a positive bound");
  // A fetch that never settles must not hang the join screen forever.
  const hanging = () => new Promise(() => {});
  const started = Date.now();
  const result = await apiFetch("https://example.invalid/join", {
    method: "POST",
    data: { displayName: "Maya", inviteCode: "RM-ABC" },
    timeoutMs: 50,
    fetchFn: hanging,
  });
  assert.ok(Date.now() - started < 5000, "timed-out fetch settles promptly");
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error?.code, "join_timeout");
});

test("M-03 F1: joinErrorMessage names the timeout with a retry", async () => {
  const { joinErrorMessage } = await import("../src/join.js");
  const mapped = joinErrorMessage({ status: 0, code: "join_timeout", action: "join" });
  assert.equal(mapped.title, "The join timed out");
  assert.match(mapped.message, /check your connection/i);
  assert.equal(mapped.retry, true);
});

test("M-03 F1: a fast fetch is unaffected by the timeout option", async () => {
  const { apiFetch } = await import("../src/join.js");
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) });
  const result = await apiFetch("https://example.invalid/preview", { timeoutMs: 50, fetchFn: okFetch });
  assert.equal(result.ok, true);
  assert.deepEqual(result.body, { hello: 1 });
});

// --- F2: double-submit guard ----------------------------------------------

test("M-03 F2: createSubmitGuard blocks a second submit while one is in flight", async () => {
  const { createSubmitGuard } = await import("../src/join.js");
  const guard = createSubmitGuard();
  assert.equal(guard.tryBegin(), true, "first submit proceeds");
  assert.equal(guard.tryBegin(), false, "Enter-key re-fire while in flight is ignored");
  guard.release();
  assert.equal(guard.tryBegin(), true, "retry works after release");
  guard.release();
});

// --- F3: touch-safe autofocus ----------------------------------------------

test("M-03 F3: consent autofocus only on fine pointers", async () => {
  const { shouldAutofocusName } = await import("../src/join.js");
  const fine = (q) => ({ matches: q === "(pointer: fine)" });
  const coarse = () => ({ matches: false });
  assert.equal(shouldAutofocusName(fine), true, "desktop keeps autofocus");
  assert.equal(shouldAutofocusName(coarse), false, "touch does not yank the keyboard over the consent details");
  assert.equal(shouldAutofocusName(undefined), false, "missing matchMedia is safe");
});

// --- F4: bare-code entry ----------------------------------------------------

test("M-03 F4: codeEntryHref builds a door-aware /join/<CODE> href", async () => {
  const { codeEntryHref } = await import("../src/join.js");
  const loc = { origin: "https://room.trydemigod.com", pathname: "/join" };
  assert.equal(codeEntryHref("RM-ABC123", loc), "https://room.trydemigod.com/join/RM-ABC123");
  assert.equal(codeEntryHref("rm-abc123", loc), "https://room.trydemigod.com/join/RM-ABC123", "lowercase codes normalize");
  assert.equal(codeEntryHref("  RM-ABC123  ", loc), "https://room.trydemigod.com/join/RM-ABC123", "pasted codes trim");
  const door = { origin: "https://www.trydemigod.com", pathname: "/room/join" };
  assert.equal(codeEntryHref("RM-ABC123", door), "https://www.trydemigod.com/room/join/RM-ABC123");
  assert.equal(codeEntryHref("not-a-code", loc), null);
  assert.equal(codeEntryHref("", loc), null);
  assert.equal(codeEntryHref("https://evil.example/x", loc), null, "URLs never become codes");
});

test("M-03 F4: join.html carries the code-entry form on the error screen", () => {
  const html = readFileSync(pathJoin(repoRoot, "join.html"), "utf8");
  assert.match(html, /id="join-code-form"/, "code entry form exists");
  assert.match(html, /id="join-code-input"/, "code input exists");
  assert.match(html, /autocapitalize="characters"/, "mobile keyboard offers uppercase for RM- codes");
  assert.match(html, /id="join-code-status"/, "code entry has a live status line");
});

// --- F5: join CTA legibility -------------------------------------------------

test("M-03 F5: join page buttons get a 1rem floor (scoped, no global change)", () => {
  const css = readFileSync(pathJoin(repoRoot, "src/public-a11y.css"), "utf8");
  // --text-md is the 1rem design token; the rule must stay scoped to the
  // join page so no other surface's buttons change.
  assert.match(css, /\.join-page\s+\.button\s*\{[^}]*font-size:\s*var\(--text-md\)/, "join-page buttons read at the 1rem token");
});
