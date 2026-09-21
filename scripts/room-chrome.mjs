// Post-#656 chrome helpers for browser checks. Catch-up, Settings, and Search
// live behind topbar controls; People starts open in the sidebar.
// Product code is unchanged — these only teach checks how to reach it.
/* global document -- page.waitForFunction runs in the browser, not here */

// The sidebar is always on screen at desktop widths and behind the Menu button
// below 900px. Anything a check reads out of it - the channel list, People, the
// archived-room note - has to come through here or it is only ever checked on
// one viewport.
export async function ensureSidebarOpen(page) {
  const sidebar = page.locator("#room-sidebar");
  if (await sidebar.isVisible()) return sidebar;
  await page.locator("#sidebar-toggle").click();
  await sidebar.waitFor({ state: "visible" });
  return sidebar;
}

// Below 900px the open sidebar is a fixed overlay, so it swallows clicks meant
// for the page behind it. A check that opened it to read something has to put
// it back before touching anything else.
export async function ensureSidebarClosed(page) {
  const shell = page.locator("#main");
  if (!(await shell.evaluate(node => node.classList.contains("sidebar-open")))) return;
  // The overlay covers the Menu button, so the toggle cannot be clicked again
  // from here. Escape is the product's own way out (src/app.js), same as a
  // member on a phone would use.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#main").classList.contains("sidebar-open"));
}

export async function ensurePeopleOpen(page) {
  await ensureSidebarOpen(page);
  const panel = page.locator("#people-panel");
  if (!(await panel.evaluate(node => node.open))) {
    await page.locator("#people-panel > summary").click();
  }
}

export async function openCatchUp(page) {
  const dialog = page.locator("#catchup-dialog");
  if (!(await dialog.evaluate(node => node.open))) {
    await page.locator("#topbar-catchup").click();
  }
  await dialog.waitFor({ state: "visible" });
  await page.locator("#return-brief-panel").evaluate(node => { node.open = true; });
}

export async function closeCatchUp(page) {
  const dialog = page.locator("#catchup-dialog");
  if (await dialog.evaluate(node => node.open)) {
    await page.locator("#catchup-close").click();
    await dialog.waitFor({ state: "hidden" });
  }
}

export async function openCatchUpPanel(page, panelId) {
  await openCatchUp(page);
  await page.locator(`#${panelId}`).evaluate(node => { node.open = true; });
}

export async function openSettings(page, panelId) {
  const dialog = page.locator("#settings-dialog");
  if (!(await dialog.evaluate(node => node.open))) {
    await page.locator("#topbar-settings").click();
  }
  await dialog.waitFor({ state: "visible" });
  if (panelId) await page.locator(`#${panelId}`).evaluate(node => { node.open = true; });
}

// Settings is a modal: anything it is left open over cannot be clicked. A
// check that opened it and then goes back to the room has to close it, the
// same way a member would.
export async function closeSettings(page) {
  const dialog = page.locator("#settings-dialog");
  if (!(await dialog.evaluate(node => node.open))) return;
  await page.locator("#settings-close").click();
  await dialog.waitFor({ state: "hidden" });
}

export async function openSearch(page) {
  const form = page.locator("#search-form");
  if (await form.isHidden()) await page.locator("#topbar-search-toggle").click();
  await form.waitFor({ state: "visible" });
}

export function dialogPrimarySubmit(page, formSelector) {
  return page.locator(`${formSelector} button[value="default"]`);
}

// Member permissions and agent controls live behind the explicit profile button.
export async function openMemberProfile(page, memberId) {
  await ensurePeopleOpen(page);
  const profile = page.locator(`[data-member-record-id="${memberId}"] .member-profile`);
  if (!(await profile.evaluate(node => node.open))) await profile.locator(":scope > summary").click();
  return profile;
}
