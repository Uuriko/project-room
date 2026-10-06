// Browser path: landing, signup, first room. Later product steps stay
// not_available until they are on the page. Times are machine milliseconds.
// The KLM figure is labeled est. on every human step.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { elapsed, emptyCreated, klmEst, probePassword, qaStamp, writeJson } from "./lib.mjs";

async function launch() {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true });
}

async function journey(browser, origin, stamp, viewport, shots) {
  const started = performance.now();
  const steps = [];
  const confusions = [];
  const page = await browser.newPage({ viewport });
  let clicks = 0;
  let chars = 0;
  const mark = (step, status = 200) => steps.push({ step, t: elapsed(started), calls: steps.length + 1, status });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20000 });
    mark("landing");
    if (shots) await page.screenshot({ path: join(shots, `home-${viewport.width}.png`) }).catch(() => {});
    const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
    await form.locator('[data-password-mode="signup"]').click({ timeout: 8000 });
    clicks += 1;
    const email = `${stamp}@example.com`;
    const password = probePassword();
    await form.locator('[name="email"]').fill(email);
    await form.locator('[name="password"]').fill(password);
    chars += email.length + password.length;
    clicks += 1;
    await form.locator('button[type="submit"]').click();
    await page.locator("#auth-panel").waitFor({ state: "hidden", timeout: 15000 });
    mark("signup");
    const room = await page.getByText("My first room", { exact: false }).waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    if (room) mark("first-room");
    else confusions.push("The first room did not appear.");
    for (const [step, text] of [["choice", "What do you want to do"], ["receipt", "Receipt"], ["connect", "Connect"]]) {
      const found = await page.getByText(text, { exact: false }).waitFor({ timeout: 1500 }).then(() => true).catch(() => false);
      if (found) mark(step);
      else confusions.push(`${step} is not available on this page.`);
    }
    const firstPost = steps.find(step => step.step === "first-room")
      ? { t: steps.find(step => step.step === "first-room").t, calls: steps.length }
      : null;
    let account = null;
    try {
      const session = await (await page.context().request.get(`${origin}/api/account-session`)).json();
      const listed = await (await page.context().request.get(`${origin}/api/account-rooms?binding=${encodeURIComponent(session.sessionBinding)}`)).json();
      account = {
        cookie: (await page.context().cookies()).map(item => `${item.name}=${item.value}`).join("; "),
        csrf: session.csrf,
        binding: session.sessionBinding,
        roomIds: (listed.rooms ?? []).map(room => room.id),
      };
    } catch { /* cleanup skips a room it cannot name */ }
    return { steps, confusions, firstPost, clicks, chars, words: 12, account };
  } finally {
    await page.close();
  }
}

export async function runHumanHome({ target, outDir = null, created = emptyCreated(), round } = {}) {
  const origin = String(target).replace(/\/$/, "");
  const stamp = qaStamp(round);
  let browser;
  try { browser = await launch(); }
  catch {
    return { status: "not_available", steps: [], firstPost: null, firstClose: null, closeReachable: false, confusions: ["Playwright did not launch, so the human home path was not measured."] };
  }
  try {
    const shots = outDir ? join(outDir, "screenshots") : null;
    if (shots) mkdirSync(shots, { recursive: true });
    const wide = await journey(browser, origin, stamp, { width: 1280, height: 800 }, shots);
    const narrow = await journey(browser, origin, qaStamp(round), { width: 390, height: 844 }, shots);
    for (const account of [wide.account, narrow.account]) {
      for (const id of account?.roomIds ?? []) {
        created.rooms.push({ id, auth: "account", cookie: account.cookie, csrf: account.csrf, binding: account.binding });
      }
    }
    const human = klmEst({ clicks: wide.clicks + narrow.clicks, chars: wide.chars + narrow.chars, words: wide.words });
    const result = {
      steps: [...wide.steps, ...narrow.steps.map(step => ({ ...step, step: `${step.step}-390` }))],
      firstPost: wide.firstPost,
      firstClose: null,
      closeReachable: false,
      confusions: [...wide.confusions, ...narrow.confusions.map(item => `390: ${item}`)],
      human,
    };
    if (!wide.firstPost) result.status = wide.confusions.some(item => item.includes("not available")) ? "not_available" : undefined;
    if (outDir) writeJson(join(outDir, "human-home.json"), result);
    return result;
  } catch {
    return { status: "not_available", steps: [], firstPost: null, firstClose: null, closeReachable: false, confusions: ["The human home path stopped before the first room."] };
  } finally {
    await browser.close();
  }
}
