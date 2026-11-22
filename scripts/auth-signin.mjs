// Authenticate disposable local browser fixtures through the real credential API.
// This helper never mounts a production form or injects store/session state.
// Since #6322 a human's first room entry can land on the full-page Updates
// view. By default the fixture then uses the visible Conversation control
// (#updates-close), as a member would, so composer journeys start from
// Conversation. Pass { landing: "default" } to keep and assert the landing.
export async function signInFixture(page, accessKey, { returnTo = page.url(), landing = "conversation" } = {}) {
  const origin = new URL(page.url()).origin;
  const hostname = new URL(origin).hostname;
  const target = new URL(returnTo);
  if (target.origin !== origin) throw new Error("Fixture return must stay on the local test server");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    throw new Error("Fixture sign-in requires a local test server");
  }
  let response;
  const accountMode = new URL(page.url()).searchParams.get("account") === "1";
  if (!accountMode) {
    response = await page.context().request.post(`${origin}/api/session`, {
      headers: { Origin: origin }, data: { accessKey }, maxRedirects: 0
    });
  }
  if (accountMode || response.status() === 401) {
    // Startup may still be minting its anonymous cookie. Wait for that actual
    // landing before restoring the fixture's browser slot.
    await page.locator("#auth-panel:visible, #workspace-nav:visible, #main:visible").first().waitFor({ state: "visible" });
    const slotResponse = await page.context().request.get(`${origin}/api/account-session`, { maxRedirects: 0 });
    if (!slotResponse.ok()) throw new Error(`Fixture account slot failed (${slotResponse.status()})`);
    const slot = await slotResponse.json();
    response = await page.context().request.post(`${origin}/api/account-session`, {
      headers: { Origin: origin, "X-CSRF-Token": slot.csrf, "X-Session-Binding": slot.sessionBinding },
      data: { accountAccessKey: accessKey, expectedSessionRevision: slot.sessionRevision }, maxRedirects: 0
    });
    if (response.status() !== 201) throw new Error(`Fixture account credential login failed (${response.status()})`);
    const account = await response.json();
    if (!account.authenticated || !account.account?.id) throw new Error("Fixture login did not return an account");
    await page.evaluate(destination => globalThis.history.replaceState(globalThis.history.state, "", destination), target.href);
    await page.reload();
    // An account lands in a room or in its Rooms list; settle a room landing.
    await page.locator("#account-rooms-panel:visible, #main:visible").first().waitFor({ state: "visible" });
    if (await page.locator("#main").isVisible()) await settleLanding(page, landing);
    return account;
  }
  if (response.status() !== 201) throw new Error(`Fixture credential login failed (${response.status()})`);
  const session = await response.json();
  if (!session.roomId || !session.member?.id) throw new Error("Fixture login did not return a room member");
  target.searchParams.set("room", session.roomId);
  await page.evaluate(destination => globalThis.history.replaceState(globalThis.history.state, "", destination), target.href);
  await page.reload();
  await page.locator("#main").waitFor({ state: "visible" });
  await settleLanding(page, landing);
  return session;
}

// The first snapshot reveals #main and opens Updates in the same task, so
// the landing is settled once #main is visible.
export async function settleLanding(page, landing = "conversation") {
  if (landing !== "conversation") return;
  const conversation = page.locator("#updates-close");
  if (await conversation.isVisible()) {
    await conversation.click();
    await page.locator("#updates-dialog").waitFor({ state: "hidden" });
  }
}
