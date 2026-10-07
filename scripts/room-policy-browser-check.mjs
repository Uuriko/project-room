import { openComposerOptions } from "./room-chrome.mjs";
// Simulated human journey against disposable first-party data, not human research.
// Issue #6 A4: when the room owner makes review or approval mandatory, the new-work
// form shows the requirement locked on with the reason, and the recorded item carries it.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { closeSettings, openSettings } from "./room-chrome.mjs";

async function setup(t, viewport = { width: 1440, height: 1000 }, { solo = false, mandatory = false } = {}) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  if (solo) for (const member of Object.values(f.store.room('commons').state.members)) {
    if (member.id !== 'owner' && member.active !== false) f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:T.MEMBER_ACCESS_CHANGED,data:{memberId:member.id,expectedMemberRevision:member.revision??0,permissions:member.permissions,active:false}});
  }
  if (mandatory) f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:T.ROOM_POLICY_SET,data:{requireIndependentReview:true,requireOwnerDecision:true}});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" }), errors = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  const items = () => f.store.room("commons").state.workItems;
  const openForm = async () => { await openComposerOptions(page); await page.locator("#new-work-button").click(); await page.locator("#new-work-form").waitFor({ state: "visible" }); await page.locator("#work-options").evaluate(el => { el.open = true; }); };
  const login = async (key, view = viewport) => {
    const other = await browser.newPage({ viewport: view, reducedMotion: "reduce" }); other.setDefaultTimeout(8000); other.on("pageerror", error => errors.push(error.message));
    await other.goto(`http://127.0.0.1:${server.address().port}`); await signInFixture(other, key);
    await other.locator("#main").waitFor({ state: "visible" }); return other;
  };
  const openDialog = async p => { await openSettings(p, "room-about"); await p.locator("#room-instructions-open").click(); await p.locator("#room-instructions-dialog").waitFor({ state: "visible" }); };
  const policy = () => f.store.room("commons").state.room.policy;
  return { ...f, page, send, items, openForm, login, openDialog, policy, review: page.locator("#require-verification"), decision: page.locator("#require-decision"), note: page.locator("#work-policy-note") };
}

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`room policy ${label}: mandatory review locks the form honestly, records the requirement, and off restores the proposer's choice`, { timeout: 60000 }, async t => {
    const f = await setup(t, viewport), { page } = f;
    await f.openForm();
    // Policy off (the default): the proposer chooses, nothing is locked and no reason is shown.
    assert.equal(await f.review.isDisabled(), false); assert.equal(await f.decision.isDisabled(), false); assert.equal(await f.note.isHidden(), true);
    await f.review.uncheck(); assert.equal(await f.review.isChecked(), false);
    // The owner flips the policy while the form is open: the live view locks both requirements on and says why.
    f.send(T.ROOM_POLICY_SET, { requireIndependentReview: true, requireOwnerDecision: true });
    await page.waitForFunction(() => document.querySelector("#require-verification").disabled);
    for (const box of [f.review, f.decision]) { assert.equal(await box.isChecked(), true); assert.equal(await box.isDisabled(), true); }
    await f.note.waitFor({ state: "visible" });
    assert.match(await f.note.textContent(), /^Room policy: independent review and owner approval are required for every new outcome in this room\. Only the room owner can change this\.$/);
    assert.equal(await page.locator("#work-options-summary").textContent(), "Advanced options");
    assert.equal(await page.locator("#verifier-field").isVisible(), true, "a reviewer must be named when review is mandatory");
    assert.match(await page.locator("#reviewer-unavailable-text").textContent(), /Room policy requires review/);
    assert.equal(await page.locator("#review-settings-button").isHidden(), true, "no shortcut to a setting the proposer cannot change");
    // Reset (e.g. reopening the form) cannot clear a mandatory requirement.
    await page.locator("#cancel-work-button").click(); await page.locator("#new-work-form").waitFor({ state: "hidden" });
    await f.openForm();
    for (const box of [f.review, f.decision]) { assert.equal(await box.isChecked(), true); assert.equal(await box.isDisabled(), true); }
    await page.locator("#work-title-input").fill("Agenda reviewed under policy");
    await page.locator("#work-done-input").fill("Reviewer confirms the agenda; owner approves.");
    await page.locator("#assignee-select").selectOption("producer"); await page.locator("#verifier-select").selectOption("reviewer");
    await page.locator('#new-work-form button[type="submit"]').click();
    await page.locator("#new-work-form").waitFor({ state: "hidden" });
    const recorded = Object.values(f.items()).find(item => item.title === "Agenda reviewed under policy");
    assert.equal(recorded.independentVerificationRequired, true); assert.equal(recorded.ownerDecisionRequired, true);
    assert.equal(recorded.verifierMemberId, "reviewer"); assert.equal(recorded.humanDecisionMakerId, "owner");
    // Only review mandatory: approval is the proposer's choice again and the reason names review alone.
    // Wait for the policy render itself: #work-policy-note is written only by syncWorkPolicy,
    // while a checkbox disabled flag is also cleared by closeWorkForm's setWorkRetry(false),
    // so waiting on the checkbox can resolve before the policy event arrives.
    f.send(T.ROOM_POLICY_SET, { requireIndependentReview: true, requireOwnerDecision: false });
    await page.waitForFunction(() => /^Room policy: independent review is required/.test(document.querySelector("#work-policy-note").textContent));
    await f.openForm();
    assert.equal(await f.review.isDisabled(), true); assert.equal(await f.decision.isDisabled(), false);
    assert.match(await f.note.textContent(), /^Room policy: independent review is required/);
    await page.locator("#cancel-work-button").click(); await page.locator("#new-work-form").waitFor({ state: "hidden" });
    // Policy off again: the existing behaviour returns, and the item recorded under policy keeps its requirements.
    // Same as above: wait for the policy-off render (the note is cleared only by syncWorkPolicy).
    f.send(T.ROOM_POLICY_SET, { requireIndependentReview: false, requireOwnerDecision: false });
    await page.waitForFunction(() => document.querySelector("#work-policy-note").textContent === "");
    await f.openForm();
    assert.equal(await f.review.isDisabled(), false); assert.equal(await f.decision.isDisabled(), false); assert.equal(await f.note.isHidden(), true);
    await f.review.uncheck(); assert.equal(await f.review.isChecked(), false);
    assert.equal(f.items()[recorded.id].independentVerificationRequired, true);
  });
}

// Follow-up to #156: the owner sets the policy from the Room instructions dialog instead of a
// hand-written command; members see the policy in force read only; both views follow live events.
for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`room policy dialog ${label}: owner applies the policy with an accessible control, errors stay inline, members see it read only`, { timeout: 60000 }, async t => {
    const f = await setup(t, viewport), { page } = f;
    const select = page.locator("#room-policy-select"), apply = page.locator("#room-policy-apply"), current = page.locator("#room-policy-current");
    await f.openDialog(page);
    // Default: policy off, nothing to apply, the control is labelled and explained.
    assert.equal(await select.inputValue(), "none"); assert.equal(await apply.isDisabled(), true);
    assert.equal(await page.locator("label[for='room-policy-select']").textContent(), "Every new outcome in this room needs");
    assert.equal(await select.getAttribute("aria-describedby"), "room-policy-help");
    assert.match(await page.locator("#room-policy-help").textContent(), /^Applies to outcomes proposed from now on/);
    assert.match(await current.textContent(), /^Nothing extra is required/);
    assert.equal(await page.locator("#room-instructions-dialog").evaluate(el => el.scrollWidth <= el.clientWidth), true);
    // Keyboard: Tab from the last instructions field reaches the select; choosing enables Apply.
    await page.locator("#room-instructions-form [name='escalation']").focus(); await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "room-policy-select");
    await select.selectOption("both"); assert.equal(await apply.isDisabled(), false);
    await apply.click(); await page.getByText("Review policy saved.", { exact: true }).waitFor();
    assert.deepEqual([f.policy().requireIndependentReview, f.policy().requireOwnerDecision, f.policy().revision], [true, true, 1]);
    assert.equal(await select.inputValue(), "both"); assert.equal(await apply.isDisabled(), true);
    assert.match(await current.textContent(), /^Independent review and an owner decision are required for every new outcome\. Set by .+ \(version 1\)\.$/);
    assert.equal(await page.evaluate(() => document.activeElement.id), "room-policy-select");
    // A refusal stays inline; the choice is kept so the owner can retry.
    let refusals = 0;
    await page.route("**/commands", route => { refusals++; return route.fulfill({ status: 422, json: { error: { code: "invalid_command", message: "Synthetic refusal" } } }); });
    await select.selectOption("review"); await apply.click();
    await page.getByText("Review policy not saved. Synthetic refusal", { exact: true }).waitFor();
    assert.equal(refusals, 1); assert.equal(await select.inputValue(), "review"); assert.equal(await apply.isDisabled(), false); assert.equal(f.policy().revision, 1);
    await page.unroute("**/commands"); await apply.click(); await page.getByText("Review policy saved.", { exact: true }).waitFor();
    assert.deepEqual([f.policy().requireIndependentReview, f.policy().requireOwnerDecision, f.policy().revision], [true, false, 2]);
    // The new-work form follows the same policy (locked review, free approval).
    await page.locator("#room-instructions-close").click(); await page.locator("#room-instructions-dialog").waitFor({ state: "hidden" });
    // Instructions opened from inside Settings, which is still up and would
    // swallow the click on the composer's New work button.
    await closeSettings(page);
    await f.openForm(); assert.equal(await f.review.isDisabled(), true); assert.equal(await f.decision.isDisabled(), false);
    await page.locator("#cancel-work-button").click();
    // A member sees the policy in force, read only, with the one-line explanation and no control.
    const guest = await f.login(f.keys.guest);
    await f.openDialog(guest);
    assert.equal(await guest.locator("#room-policy-owner").isHidden(), true); assert.equal(await guest.locator("#room-policy-select").isVisible(), false);
    assert.match(await guest.locator("#room-policy-current").textContent(), /^Independent review is required for every new outcome\. Set by .+ \(version 2\)\.$/);
    assert.equal(await guest.locator("#room-policy-help").textContent(), "Only the room owner can change this.");
    assert.equal(await guest.locator("#room-instructions-edit").isHidden(), true);
    // Live room.policy_set events update both views without a reload.
    f.send(T.ROOM_POLICY_SET, { requireIndependentReview: false, requireOwnerDecision: true });
    await guest.waitForFunction(() => document.querySelector("#room-policy-current").textContent.startsWith("An owner decision is required"));
    await f.openDialog(page);
    await page.waitForFunction(() => document.querySelector("#room-policy-select").value === "decision");
    assert.match(await current.textContent(), /\(version 3\)\.$/); assert.equal(await apply.isDisabled(), true);
    await guest.close();
  });
}

// Initial solo defaults remove choices with only one valid answer; the real
// form still submits the same permission-checked proposal and never accepts it.
for(const scenario of [
  {name:'solo desktop',solo:true,viewport:{width:1440,height:1000}},
  {name:'solo mobile',solo:true,viewport:{width:390,height:844}},
  {name:'mandatory solo',solo:true,mandatory:true,viewport:{width:1440,height:1000}},
  {name:'multiplayer',solo:false,viewport:{width:1440,height:1000}}
]) test(`initial work defaults ${scenario.name}: eligibility and review stay honest`,{timeout:60000},async t=>{
  const f=await setup(t,scenario.viewport,scenario),{page}=f;
  const row=page.locator('[data-message-record-id="test-welcome"]');
  await row.locator('.message-more > summary').click();
  await row.getByRole('button',{name:'Make this work',exact:true}).click();
  await page.locator('#work-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#assignee-select').inputValue(),scenario.solo?'owner':'');
  assert.equal(await f.review.isChecked(),!scenario.solo || scenario.mandatory===true);
  assert.equal(await f.review.isDisabled(),scenario.mandatory===true);
  if(scenario.solo&&!scenario.mandatory) {
    await page.locator('#work-options-summary').getByText('No review · Advanced options',{exact:true}).waitFor();
    assert.equal(await page.locator('#verifier-field').isVisible(),false);
    assert.equal(await page.locator('#work-options').evaluate(n=>n.open),false,'no settings interstitial is required');
    await page.locator('#work-title-input').fill(`Solo outcome ${scenario.name}`);
    await page.locator('#work-done-input').fill('A clear note is saved.');
    await page.locator('#create-work-button').click();
    await page.locator('#work-dialog').waitFor({state:'hidden'});
    const saved=Object.values(f.items()).find(i=>i.title===`Solo outcome ${scenario.name}`);
    assert.ok(saved);assert.equal(saved.accountableMemberId,'owner');assert.equal(saved.independentVerificationRequired,false);
    assert.equal(saved.ownerDecisionRequired,true);assert.equal(saved.state,'proposed','creating your own work does not accept it');
    await row.locator('.message-more > summary').click();await row.getByRole('button',{name:'Make this work',exact:true}).click();
    await page.locator('#work-options-summary').click();await f.review.check();
    assert.equal(await page.locator('#verifier-field').isVisible(),true,'optional review remains available');
    assert.equal(await page.locator('#reviewer-unavailable').isVisible(),true,'opting in explains the missing independent reviewer');
    // Background changes cannot reset an explicit choice or silently retarget it.
    f.send(T.MESSAGE_POSTED,{messageId:crypto.randomUUID(),body:'A background update.'});
    await page.getByText('A background update.',{exact:true}).waitFor();
    assert.equal(await f.review.isChecked(),true);assert.equal(await page.locator('#assignee-select').inputValue(),'owner');
    await page.locator('#cancel-work-button').click();
    const card=page.locator(`[data-work-record-id="${saved.id}"]`);
    await card.locator('.work-details > summary').click();await card.locator('[data-reuse-work]').click();
    await page.locator('#work-dialog').waitFor({state:'visible'});
    assert.equal(await page.locator('#work-title-input').inputValue(),saved.title);
    assert.equal(await page.locator('#assignee-select').inputValue(),'','reuse remains definition-only even in a solo room');
    assert.equal(await f.review.isChecked(),true,'reuse does not inherit the original optional-review choice');
  } else if(scenario.mandatory) {
    assert.equal(await page.locator('#reviewer-unavailable').isVisible(),true);
    assert.match(await f.note.textContent(),/independent review/);
    assert.equal(await page.locator('#review-settings-button').isHidden(),true);
  } else {
    assert.equal(await page.locator('#verifier-field').isVisible(),true);
    assert.match(await page.locator('#work-options-summary').textContent(),/^(Advanced options|Review \+ approval · read only)$/);
  }
});
