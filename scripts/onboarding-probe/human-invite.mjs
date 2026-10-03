// Owner mints a share link. A 390px visitor opens it and sends a first message
// when the composer is on the page. Missing UI is not_available, not a throw.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cookieJar, elapsed, emptyCreated, klmEst, probeFetch, probePassword, qaStamp, writeJson } from "./lib.mjs";

function accountHeaders(origin, session) {
  return {
    origin, cookie: session.cookie, "content-type": "application/json",
    "x-csrf-token": session.csrf, "x-session-binding": session.binding, "x-project-room-auth": "account",
  };
}

async function owner(origin, stamp) {
  const jar = cookieJar();
  const first = await probeFetch(`${origin}/api/account-session`, { headers: { origin } });
  jar.store(first);
  const signup = await probeFetch(`${origin}/api/auth/password/signup`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      email: `${stamp}@example.com`, password: probePassword(),
      sessionRevision: first.json?.sessionRevision, sessionToken: jar.get("account_session"),
    }),
  });
  jar.store(signup);
  return { status: signup.status, cookie: jar.header(), csrf: signup.json?.csrf, binding: signup.json?.sessionBinding, bytes: first.bytes + signup.bytes };
}

export async function runHumanInvite({ target, outDir = null, created = emptyCreated(), round } = {}) {
  const origin = String(target).replace(/\/$/, "");
  const started = performance.now();
  const steps = [];
  const confusions = [];
  const stamp = qaStamp(round);
  let calls = 0;
  const session = await owner(origin, stamp);
  calls += 2;
  steps.push({ step: "owner-signup", t: elapsed(started), calls, bytes: session.bytes, status: session.status });
  if (session.status !== 201) {
    return done(outDir, { status: "not_available", steps, firstPost: null, firstClose: null, closeReachable: false, confusions: ["The invite owner could not sign up."] });
  }
  const roomId = `qai${Date.now().toString(36)}`;
  const room = await probeFetch(`${origin}/api/account-rooms`, {
    method: "POST", headers: accountHeaders(origin, session),
    body: JSON.stringify({ roomId, title: "Probe invite", purpose: "Onboarding probe", kind: "personal", displayName: stamp }),
  });
  calls += 1;
  steps.push({ step: "owner-room", t: elapsed(started), calls, bytes: room.bytes, status: room.status });
  if (room.status !== 201 && room.status !== 200) {
    return done(outDir, { status: "not_available", steps, firstPost: null, firstClose: null, closeReachable: false, confusions: ["The invite room was not created."] });
  }
  created.rooms.push({ id: roomId, auth: "account", cookie: session.cookie, csrf: session.csrf, binding: session.binding });
  const state = await probeFetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}`, { headers: accountHeaders(origin, session) });
  calls += 1;
  const revision = state.json?.member?.revision ?? state.json?.viewer?.member?.revision;
  if (!Number.isInteger(revision)) {
    confusions.push("A share link needs the owner's current membership revision, which this response did not include.");
    return done(outDir, { status: "not_available", steps, firstPost: null, firstClose: null, closeReachable: false, confusions, human: klmEst({ clicks: 0, chars: 0, words: 0 }) });
  }
  const linkToken = randomBytes(32).toString("base64url");
  const link = await probeFetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}/share-links`, {
    method: "POST", headers: accountHeaders(origin, session),
    body: JSON.stringify({ requestId: randomUUID(), linkToken, expiresAt: Date.now() + 60 * 60 * 1000, maxJoins: 1, expectedMemberRevision: revision }),
  });
  calls += 1;
  steps.push({ step: "mint-link", t: elapsed(started), calls, bytes: link.bytes, status: link.status });
  if (link.status !== 201 && link.status !== 200) {
    confusions.push("The share link was not minted.");
    return done(outDir, { status: "not_available", steps, firstPost: null, firstClose: null, closeReachable: false, confusions });
  }
  let browser;
  try { ({ chromium: browser } = await import("playwright")); }
  catch {
    confusions.push("Playwright did not launch, so the guest visit was not measured.");
    return done(outDir, { status: "not_available", steps, firstPost: null, firstClose: null, closeReachable: false, confusions });
  }
  const launched = await browser.launch({ headless: true });
  try {
    const page = await launched.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${origin}/#join/${linkToken}`, { waitUntil: "domcontentloaded", timeout: 20000 });
    steps.push({ step: "guest-open", t: elapsed(started), calls, status: 200 });
    if (outDir) {
      mkdirSync(join(outDir, "screenshots"), { recursive: true });
      await page.screenshot({ path: join(outDir, "screenshots", "invite-390.png") }).catch(() => {});
    }
    const box = page.locator("textarea").first();
    const visible = await box.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!visible) {
      confusions.push("The guest composer is not available, so the first message was not sent.");
      return done(outDir, { status: "not_available", steps, firstPost: null, firstClose: null, closeReachable: false, confusions, human: klmEst({ clicks: 1, chars: 0, words: 4 }) });
    }
    const message = "hello from the probe";
    await box.fill(message);
    const send = page.getByRole("button", { name: /send|post/i }).first();
    if (await send.count()) await send.click();
    else await box.press("Enter");
    steps.push({ step: "first-message", t: elapsed(started), calls: calls + 1, status: 200 });
    const firstPost = { t: elapsed(started), calls: calls + 1 };
    return done(outDir, {
      steps, firstPost, firstClose: null, closeReachable: false, confusions,
      human: klmEst({ clicks: 2, chars: message.length, words: 4 }),
    });
  } catch {
    confusions.push("The guest visit did not finish.");
    return done(outDir, { status: "not_available", steps, firstPost: null, firstClose: null, closeReachable: false, confusions });
  } finally {
    await launched.close();
  }
}

function done(outDir, result) {
  if (outDir) writeJson(join(outDir, "human-invite.json"), result);
  return result;
}
