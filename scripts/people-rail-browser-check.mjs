import { enableHumanAdvanced, ensurePeopleOpen } from "./room-chrome.mjs";
import { clickChrome } from "./room-chrome.mjs";
import { openSettings, closeSettings } from "./room-chrome.mjs";
// People-rail: presence dots, one-line status, loud @agent handles, Done chips.
// Also checks tip #11 Done-chip spring is instant under prefers-reduced-motion.
// Real browser + local HTTP service; identities and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { makeTestSigner } from "./helpers/signed-evidence.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

test("People rail shows presence, what they're on, loud @handles, and Done chips", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-people-rail-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  let observedAt = Date.now(); store.now = () => observedAt;
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "codex", displayName: "Codex", kind: "agent",
    permissions: ["accept_work", "complete_work"]
  }));
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "instinct", displayName: "Instinct", kind: "agent",
    permissions: ["accept_work", "complete_work", "verify"]
  }));
  // Graduated autonomy tiers: new agents enroll at t1_readonly; promote the
  // fixture agent so the check exercises it as a working agent.
  setTier(store.db, "commons", "codex", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const agent = store.issueAccessKey("commons", "codex");
  store.command(owner, "commons", command(T.WORK_PROPOSED, {
    workItemId: "work-review", title: "Review the Project Room v0 contract",
    definitionOfDone: "Exact spec revision is checked.",
    accountableMemberId: "codex", mode: "read"
  }));
  store.command(agent, "commons", command(T.WORK_ACCEPTED, { workItemId: "work-review", expectedRevision: 0 }));
  store.command(agent, "commons", command(T.WORK_STARTED, { workItemId: "work-review", expectedRevision: 1 }));
  const signEvidence = makeTestSigner(store);
  store.command(agent, "commons", command(T.WORK_COMPLETED, {
    workItemId: "work-review", expectedRevision: 2, producerId: "codex",
    summary: "Four consistency corrections before implementation.",
    evidenceUrl: "https://example.invalid/review", evidenceVersion: "v1",
    nextAction: "Keep the receipt on the rail", signedEvidence: signEvidence()
  }));
  store.command(owner, "commons", command(T.WORK_PROPOSED, {
    workItemId: "work-build", title: "Build the first executable Room slice",
    definitionOfDone: "A browser prototype replays the loop.",
    accountableMemberId: "codex", mode: "read"
  }));
  store.command(agent, "commons", command(T.WORK_ACCEPTED, { workItemId: "work-build", expectedRevision: 0 }));
  store.command(agent, "commons", command(T.WORK_STARTED, { workItemId: "work-build", expectedRevision: 1 }));

  const identity = store.identities.create("Signal agent");
  store.identities.link(owner, "commons", { identityId: identity.identityId, memberId: "signal-agent", displayName: "Signal agent", permissions: ["accept_work", "complete_work"] });
  setTier(store.db, "commons", "signal-agent", "t2_standard", { updatedBy: "owner", nowMs: observedAt });
  store.command(owner, "commons", command(T.WORK_PROPOSED, { workItemId: "signal-work", title: "Check the observation path", definitionOfDone: "Live signals observed", accountableMemberId: "signal-agent", mode: "read" }));
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })).newPage();
  await page.clock.install();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await enableHumanAdvanced(page);
  if (!(await page.locator("#people-panel").evaluate(node => node.open))) {
    await page.locator("#people-panel > summary").click();
  }
  assert.equal(await page.locator("#people-hint, #people-wake-hint").count(), 0, "no repeated onboarding paragraphs in the member list");
  await openSettings(page);
  await page.locator("#create-room-details > summary").click();
  const createCopy = await page.locator("#create-room-details").innerText();
  // UI calming: the Create Room block was de-jargoned — no API route, secret,
  // schema, or fragment explanation; it points at ⌘K → Create Room.
  assert.match(createCopy, /Start your own room/);
  assert.match(createCopy, /account workspace/);
  assert.doesNotMatch(createCopy, /POST \/room\/api\/agent-rooms/);
  assert.doesNotMatch(createCopy, /pri_/);
  assert.doesNotMatch(createCopy, /share https:\/\/www\.getdasha\.com\/room#room/);
  mkdirSync("test-results", { recursive: true });
  await closeSettings(page);
  await page.locator("#people-panel").screenshot({ path: "test-results/people-rail-create-room.png" });
  await clickChrome(page, "#invite-people-button");
  await page.locator("#share-link-dialog").waitFor({ state: "visible" });
  await page.locator("#growth-agent-code").click();
  await page.locator("#agent-invite-dialog").waitFor({ state: "visible" });
  assert.match(await page.locator("#agent-invite-dialog").innerText(), /Choose what it can do/);
  await page.locator("#agent-invite-mint").click();
  const code = page.locator("#agent-invite-link");
  await code.waitFor({ state: "visible" });
  assert.match(await code.getAttribute("href"), /\/join\/RM-/);
  assert.equal(await page.locator("#agent-invite-code").count(), 0);
  assert.equal(await code.textContent(), await code.getAttribute("href"), "selectable link remains available when clipboard fails");
  assert.match(await page.locator("#agent-invite-share").textContent(), /agent-inbox.mjs join/);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true,
    value: { writeText: async text => { globalThis.copiedAgentInvite = text; } } }); });
  await page.locator("#agent-invite-copy").click();
  assert.match(await page.evaluate(() => globalThis.copiedAgentInvite), /\/join\/RM-/);
  assert.match(await page.evaluate(() => globalThis.copiedAgentInvite), /^https?:\/\/[^/]+\/join\/RM-/);
  await page.locator("#agent-invite-dialog").screenshot({ path: "test-results/agent-invite-connection.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#agent-invite-dialog").evaluate(node => node.scrollWidth <= node.clientWidth), true, "invitation URL wraps inside the mobile dialog");
  await page.locator("#agent-invite-dialog").screenshot({ path: "test-results/agent-invite-connection-mobile.png" });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.locator("#agent-invite-close").click();
  await page.locator("#share-link-close").click();
  await page.locator("#share-link-dialog").waitFor({ state: "hidden" });
  await page.evaluate(() => { location.hash = "#room/commons"; });
  assert.equal(await page.locator("#people-panel").evaluate(node => node.open), true);
  const codex = page.locator('#presence-list .presence-member[data-member-record-id="codex"]');
  const instinct = page.locator('#presence-list .presence-member[data-member-record-id="instinct"]');
  const ownerRow = page.locator('#presence-list .presence-member[data-member-record-id="owner"]');
  await codex.waitFor();
  // Assignment is context; recent authenticated commands establish Idle,
  // while a member with no observation remains Unknown. Neither proves work.
  assert.equal(await codex.getAttribute("data-presence"), "idle");
  assert.equal(await instinct.getAttribute("data-presence"), "unknown");
  assert.equal(await codex.locator(".member-profile").evaluate(node => node.open), false);
  assert.equal(await codex.locator(".member-availability").textContent(), "Idle");
  assert.equal(await codex.locator(".member-handle-agent").textContent(), "@Codex");
  assert.equal(await instinct.locator(".member-handle-agent").textContent(), "@Instinct");
  assert.doesNotMatch(await ownerRow.locator(".member-handle").textContent(), /^@/);
  assert.equal(await codex.locator(".member-profile .member-status").textContent(), "Assigned: Build the first executable Room slice");
  assert.equal(await instinct.locator(".member-profile .member-status").textContent(), "Agent");
  const signal = page.locator('[data-member-record-id="signal-agent"]');
  assert.equal(await signal.locator(".member-availability").textContent(), "No live signal");
  assert.equal(await signal.locator(".member-assignment").isVisible(), true, "assignment is visible without opening the profile");
  const refresh = async () => {
    const response = page.waitForResponse(response => response.url().endsWith("/api/rooms/commons/presence"));
    await page.locator('[data-refresh-presence]').click(); await response;
  };
  const heartbeat = async () => {
    const response = await page.request.post(origin + "/api/agent-heartbeats", { headers: { Authorization: `Bearer ${identity.secret}` }, data: { hostId: "signal-host", mode: "pull-only" } });
    assert.equal(response.status(), 200);
  };
  await heartbeat(); await refresh();
  await signal.locator('.member-availability').filter({ hasText: /^Listening$/ }).waitFor();
  assert.equal(await signal.locator('.member-profile').evaluate(node => node.open), false, 'live availability is readable without opening options');
  const profile = signal.locator('.member-profile');
  await profile.locator(':scope > summary').click();
  assert.equal(await signal.locator('.member-owned-by').textContent(), `Agent identity: ${identity.identityId}`);
  assert.ok(await signal.locator('.member-observation time').getAttribute('datetime'));
  const started = await page.request.post(origin + "/api/rooms/commons/work-sessions", { headers: { Authorization: `Bearer ${identity.secret}` }, data: { requestId: crypto.randomUUID(), workItemId: "signal-work", expectedRevision: 0, action: "set_status", status: "processing" } });
  assert.equal(started.status(), 201); await refresh();
  await signal.locator('.member-availability').filter({ hasText: /^Working$/ }).waitFor();
  assert.match(await signal.locator('.member-working-on').textContent(), /Check the observation path/);
  const presenceRoute = /\/api\/rooms\/commons\/presence(?:\?|$)/;
  // Browser wall clock and a real transport hold model an aged tab returning;
  // this is an explicit visibility event, not a physically suspended machine.
  await page.locator('#message-input').fill('Resume keeps this unsent draft');
  await page.locator('#message-input').evaluate(node => node.setSelectionRange(7, 12));
  await profile.locator(':scope > summary').focus();
  let releaseResume;
  const resumeGate = new Promise(resolve => { releaseResume = resolve; });
  await page.route(presenceRoute, async route => { await resumeGate; await route.continue(); });
  await page.clock.setSystemTime(new Date(Date.now() + 61000));
  const resumeRequest = page.waitForRequest(request => presenceRoute.test(request.url()));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await signal.locator('.member-availability').filter({ hasText: /^Availability needs refresh$/ }).waitFor({ timeout: 3000 });
  await resumeRequest;
  assert.equal(await signal.getAttribute('data-presence'), 'unknown');
  assert.equal(await signal.locator('.presence-dot').getAttribute('title'), 'Availability needs refresh');
  assert.equal(await signal.locator('.member-state-chip').textContent(), 'Availability needs refresh');
  assert.match(await signal.locator('.member-working-on').textContent(), /^Last reported working on /);
  assert.match(await page.locator('.presence-check-note').textContent(), /60 seconds.*Last successful check:/);
  assert.equal(await profile.evaluate(node => node.open), true);
  assert.equal(await profile.locator(':scope > summary').evaluate(node => node === document.activeElement), true);
  assert.deepEqual(await page.locator('#message-input').evaluate(node => [node.value, node.selectionStart, node.selectionEnd]), ['Resume keeps this unsent draft', 7, 12]);
  for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(mode => { document.documentElement.dataset.theme = mode; }, theme);
    if (width === 390 && !await page.locator('#main').evaluate(node => node.classList.contains('sidebar-open'))) await page.locator('#sidebar-toggle').click();
    await signal.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/availability-resume-${width}-${theme}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (await page.locator('#main').evaluate(node => node.classList.contains('sidebar-open'))) await page.keyboard.press('Escape');
  await profile.locator(':scope > summary').focus();
  releaseResume();
  await signal.locator('.member-availability').filter({ hasText: /^Working$/ }).waitFor();
  await page.unroute(presenceRoute);
  assert.equal(await profile.locator(':scope > summary').evaluate(node => node === document.activeElement), true);
  assert.match(await signal.locator('.member-working-on').textContent(), /^working on /);
  assert.doesNotMatch(await page.locator('.presence-check-note').textContent(), /needs refresh|could not refresh/);
  // The visible panel must expire without a visibility event or another write.
  let releaseVisible, visibleRequests = 0;
  const visibleGate = new Promise(resolve => { releaseVisible = resolve; });
  await page.route(presenceRoute, async route => { visibleRequests++; await visibleGate; await route.continue(); });
  await page.clock.fastForward(60001);
  await signal.locator('.member-availability').filter({ hasText: /^Availability needs refresh$/ }).waitFor();
  assert.equal(visibleRequests, 1, 'intervals share one request for the owned observation');
  assert.match(await signal.locator('.member-working-on').textContent(), /^Last reported working on /);
  releaseVisible();
  await signal.locator('.member-availability').filter({ hasText: /^Working$/ }).waitFor();
  await page.unroute(presenceRoute);
  await page.route(presenceRoute, route => route.abort());
  await page.locator('[data-refresh-presence]').click();
  await signal.locator('.member-availability').filter({ hasText: /^Availability not refreshed$/ }).waitFor();
  assert.equal(await signal.getAttribute('data-presence'), 'unknown');
  assert.equal(await signal.locator('.member-working-on').count(), 0, 'cached work is not shown as currently running after failure');
  assert.match(await signal.locator('.member-assignment').textContent(), /^Assigned: /);
  assert.equal(await profile.evaluate(node => node.open), true);
  assert.match(await page.locator('.presence-check-note').textContent(), /Last successful check:/);
  assert.equal(await page.locator('[data-refresh-presence]').evaluate(node => node === document.activeElement), true);
  await page.unroute(presenceRoute); await refresh();
  await signal.locator('.member-availability').filter({ hasText: /^Working$/ }).waitFor();
  assert.equal(await page.locator('[data-refresh-presence]').evaluate(node => node === document.activeElement), true, 'successful refresh retains the explicit retry focus');
  assert.doesNotMatch(await page.locator('.presence-check-note').textContent(), /could not refresh/);
  observedAt += 20 * 60 * 1000; await refresh();
  await signal.locator('.member-availability').filter({ hasText: /^Unreachable$/ }).waitFor();
  assert.equal(await signal.locator('.member-working-on').count(), 0);
  assert.match(await signal.locator('.member-assignment').textContent(), /^Assigned: /);
  await heartbeat(); await refresh();
  await signal.locator('.member-availability').filter({ hasText: /^Listening$/ }).waitFor();
  const chip = codex.locator(".done-chip");
  assert.equal(await chip.textContent(), "Done");
  assert.equal(await chip.getAttribute("data-done-work"), "work-review");
  assert.match(await chip.getAttribute("title"), /consistency corrections/);
  assert.equal(await instinct.locator(".done-chip").count(), 0);
  // Context is reducedMotion: "reduce" — chip must be instant, not mid-spring.
  const reduced = await chip.evaluate(el => {
    const style = getComputedStyle(el);
    return { animationName: style.animationName, opacity: style.opacity, transform: style.transform };
  });
  assert.equal(reduced.animationName, "none");
  assert.equal(reduced.opacity, "1");
  assert.equal(reduced.transform, "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  assert.equal(await chip.evaluate(el => getComputedStyle(el).animationName), "done-chip-pop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ownerRow.click();
  assert.match(await page.locator("#message-input").inputValue(), /@Room owner/);
  mkdirSync("test-results", { recursive: true });
  await page.locator("#people-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/people-rail-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#sidebar-toggle").click();
  await ensurePeopleOpen(page);
  await page.locator("#people-panel").scrollIntoViewIfNeeded();
  await codex.waitFor();
  await page.screenshot({ path: "test-results/people-rail-mobile.png" });
  // Gate: the existing rail owner now distinguishes membership removal from
  // idle presence. A flat rail or age-based hiding fails this user contract.
  const instinctKey = store.issueAccessKey("commons", "instinct");
  store.command(instinctKey, "commons", command(T.MESSAGE_POSTED, { messageId: "old-agent-note", body: "A historical contribution from Instinct" }));
  store.command(owner, "commons", command(T.MEMBER_ACCESS_CHANGED, { memberId: "instinct", expectedMemberRevision: 0, permissions: [], active: false }));
  const removed = page.locator('#presence-list .removed-agents');
  await removed.waitFor();
  assert.equal(await removed.locator(':scope > summary').textContent(), 'Removed agents (1)');
  assert.equal(await removed.evaluate(node => node.open), false);
  assert.equal(await instinct.isVisible(), false, 'revoked agents leave the normal visible rail');
  assert.equal(await codex.isVisible(), true, 'an active agent without a live signal remains in the normal rail');
  await removed.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await instinct.isVisible(), true);
  const removedProfile = instinct.locator('.member-profile');
  await removedProfile.locator(':scope > summary').click();
  assert.equal(await instinct.locator('.member-profile .member-status').textContent(), 'access revoked');
  assert.equal(await instinct.locator('[data-member-remove], [data-member-pause]').count(), 0);
  store.command(owner, 'commons', command(T.MEMBER_ADDED, { memberId: 'new-agent', displayName: 'New agent', kind: 'agent', permissions: [] }));
  await page.locator('[data-member-record-id="new-agent"]').waitFor();
  assert.equal(await removed.evaluate(node => node.open), true);
  assert.equal(await removedProfile.evaluate(node => node.open), true);
  assert.equal(await removedProfile.locator(':scope > summary').evaluate(node => node === document.activeElement), true, 'profile focus survives the updated rail');
  assert.equal(await page.locator('[data-message-record-id="old-agent-note"] .message-meta strong').textContent(), 'Instinct', 'past attribution remains visible');
  assert.ok((await removed.locator(':scope > summary').boundingBox()).height >= 44);
  for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(mode => { document.documentElement.dataset.theme = mode; }, theme);
    await removed.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/availability-and-removed-${width}-${theme}.png` });
  }
  store.command(owner, 'commons', command(T.MEMBER_ACCESS_CHANGED, { memberId: 'instinct', expectedMemberRevision: 1, permissions: [], active: true }));
  await removed.waitFor({ state: 'detached' });
  assert.equal(await instinct.isVisible(), true, 'restored membership returns to the regular rail');
  assert.equal(await instinct.locator('.member-profile').evaluate(node => node.open), true);
  assert.equal(await instinct.locator('.member-profile > summary').evaluate(node => node === document.activeElement), true);
  // A delayed failure belongs to the observation snapshot that requested it.
  // A newer real room snapshot must not inherit that failure qualification.
  await page.setViewportSize({ width: 1440, height: 1000 });
  let releaseOld, sawOld;
  const oldHeld = new Promise(resolve => { sawOld = resolve; });
  const oldReleased = new Promise(resolve => { releaseOld = resolve; });
  let holdFirst = true;
  await page.route(presenceRoute, async route => {
    if (!holdFirst) { await route.continue(); return; }
    holdFirst = false; sawOld(); await oldReleased; await route.abort();
  });
  await page.locator('[data-refresh-presence]').click(); await oldHeld;
  store.command(owner, 'commons', command(T.MEMBER_ADDED, { memberId: 'snapshot-agent', displayName: 'Snapshot agent', kind: 'agent', permissions: [] }));
  await page.locator('[data-member-record-id="snapshot-agent"]').waitFor();
  await refresh();
  await signal.locator('.member-availability').filter({ hasText: /^Listening$/ }).waitFor();
  const oldFailed = page.waitForEvent('requestfailed', request => presenceRoute.test(request.url()));
  releaseOld(); await oldFailed;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await signal.locator('.member-availability').textContent(), 'Listening');
  assert.doesNotMatch(await page.locator('.presence-check-note').textContent(), /could not refresh/);
  await page.unroute(presenceRoute); await refresh();
  // A captured real response from commons must not populate a restored room.
  store.initialize(initialRoom('resume-room'));
  const nextOwner = store.issueAccessKey('resume-room', 'owner');
  store.command(nextOwner, 'resume-room', command(T.MEMBER_ADDED, { memberId: 'signal-agent', displayName: 'Restored signal agent', kind: 'agent', permissions: [] }));
  let releaseRoom, sawRoom;
  const roomHeld = new Promise(resolve => { sawRoom = resolve; });
  const roomGate = new Promise(resolve => { releaseRoom = resolve; });
  await page.route(presenceRoute, async route => { const response = await route.fetch(); sawRoom(); await roomGate; await route.fulfill({ response }); });
  await page.locator('[data-refresh-presence]').click(); await roomHeld;
  const switched = await page.request.post(origin + '/api/session', { headers: { Origin: origin }, data: { accessKey: nextOwner } });
  assert.equal(switched.status(), 201);
  const restoredPresence = page.waitForResponse(response => response.url().endsWith('/api/rooms/resume-room/presence'));
  await page.evaluate(() => {
    history.replaceState(null, '', '?room=resume-room#room/resume-room');
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await restoredPresence;
  await enableHumanAdvanced(page);
  await ensurePeopleOpen(page);
  await signal.locator('.member-availability').filter({ hasText: /^No live signal$/ }).waitFor();
  const oldRoomResponse = page.waitForResponse(response => presenceRoute.test(response.url()));
  releaseRoom(); await oldRoomResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await signal.locator('.member-availability').textContent(), 'No live signal');
  assert.equal(await signal.locator('.member-working-on, .member-owned-by').count(), 0);
  await page.unroute(presenceRoute);
  const nextRefresh = page.waitForResponse(response => response.url().endsWith('/api/rooms/resume-room/presence'));
  await page.locator('[data-refresh-presence]').click(); await nextRefresh;
  assert.equal(await signal.locator('.member-availability').textContent(), 'No live signal', 'obsolete finally cannot block the new room retry');
  assert.equal(errors.join("\n"), "");
});
