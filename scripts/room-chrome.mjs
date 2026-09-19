// Post-#656 chrome helpers for browser checks. Catch-up, Settings, and Search
// live behind topbar controls; People starts open in the sidebar.
// Product code is unchanged — these only teach checks how to reach it.

export async function ensurePeopleOpen(page) {
  const sidebar = page.locator("#room-sidebar");
  if (!(await sidebar.isVisible())) {
    await page.locator("#sidebar-toggle").click();
    await sidebar.waitFor({ state: "visible" });
  }
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

// Open the dialog without triggering the app's loadReturnBrief (for tests
// that need the dialog open but must not refresh the brief).
export async function openCatchUpNoLoad(page) {
  await page.evaluate(() => {
    const dialog = document.querySelector("#catchup-dialog");
    if (dialog && !dialog.open) dialog.showModal();
    const panel = document.querySelector("#return-brief-panel");
    if (panel) panel.open = true;
  });
  await page.locator("#catchup-dialog").waitFor({ state: "visible" });
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

export async function openSearch(page) {
  const form = page.locator("#search-form");
  if (await form.isHidden()) await page.locator("#topbar-search-toggle").click();
  await form.waitFor({ state: "visible" });
}

export function dialogPrimarySubmit(page, formSelector) {
  return page.locator(`${formSelector} button[value="default"]`);
}
