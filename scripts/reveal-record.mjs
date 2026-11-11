// Private requests live in their direct conversation (#5322), not the public
// timeline. Browser checks that address a record by id open whichever direct
// conversation holds it before acting on it, opening the narrow sidebar first.
export async function revealRecord(page, id) {
  const record = page.locator(`[data-message-record-id="${id}"]`);
  if (await record.count()) return record;
  const toggle = page.locator("#sidebar-toggle");
  const sidebar = async open => {
    if (!await toggle.isVisible().catch(() => false)) return;
    if ((await toggle.getAttribute("aria-expanded") === "true") !== open) await toggle.click();
  };
  await sidebar(true);
  for (const peer of await page.locator("#direct-message-list [data-direct-member]").all()) {
    await peer.click();
    await sidebar(false);
    try { await record.waitFor({ timeout: 2000 }); return record; } catch {}
    await sidebar(true);
  }
  await sidebar(false);
  return record;
}

// Return from a direct conversation to a public channel (default: the room's first channel).
export async function openChannel(page, selector = "[data-channel]") {
  const toggle = page.locator("#sidebar-toggle");
  const narrow = await toggle.isVisible().catch(() => false);
  if (narrow && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await page.locator(selector).first().click();
  if (narrow && await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
}
