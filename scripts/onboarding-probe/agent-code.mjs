// Mint a contribute invite from a probe owner account and follow GET /a/<code>.
// The page is the only source of the redeem, orient, and board calls.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cookieJar, elapsed, emptyCreated, executeCurl, extractCurls, probeFetch, qaStamp, writeJson } from "./lib.mjs";

function accountHeaders(origin, session, json = true) {
  return {
    origin,
    cookie: session.cookie,
    "x-csrf-token": session.csrf,
    "x-session-binding": session.binding,
    "x-project-room-auth": "account",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function openAccount(origin, stamp) {
  const jar = cookieJar();
  const first = await probeFetch(`${origin}/api/account-session`, { headers: { origin } });
  jar.store(first);
  const signup = await probeFetch(`${origin}/api/auth/password/signup`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      email: `${stamp}@example.com`,
      password: "qa-probe-pw",
      sessionRevision: first.json?.sessionRevision,
      sessionToken: jar.get("account_session"),
    }),
  });
  jar.store(signup);
  let csrf = signup.json?.csrf;
  let binding = signup.json?.sessionBinding;
  let extraBytes = 0;
  let calls = 2;
  if (signup.status === 202 && jar.header()) {
    const session = await probeFetch(`${origin}/api/account-session`, { headers: { origin, cookie: jar.header() } });
    jar.store(session);
    csrf = session.json?.csrf ?? csrf;
    binding = session.json?.sessionBinding ?? binding;
    extraBytes = session.bytes;
    calls += 1;
  }
  return {
    calls,
    bytes: first.bytes + signup.bytes + extraBytes,
    status: signup.status,
    cookie: jar.header(),
    csrf,
    binding,
  };
}

async function postAccount(origin, path, session, body) {
  return probeFetch(`${origin}${path}`, {
    method: "POST",
    headers: accountHeaders(origin, session),
    body: JSON.stringify(body),
  });
}

export async function runAgentCode({ target, outDir = null, created = emptyCreated(), round } = {}) {
  const origin = String(target).replace(/\/$/, "");
  const started = performance.now();
  const steps = [];
  const confusions = [];
  const stamp = qaStamp(round);
  let calls = 0;
  const session = await openAccount(origin, stamp);
  calls += session.calls;
  steps.push({ step: "signup", t: elapsed(started), calls, bytes: session.bytes, status: session.status });
  if (session.status !== 201 && session.status !== 202) {
    confusions.push("Probe owner signup did not succeed.");
    return finish(outDir, blank(steps, confusions));
  }
  const roomId = `qap${Date.now().toString(36)}`;
  const room = await postAccount(origin, "/api/account-rooms", session, {
    roomId, title: "Probe room", purpose: "Onboarding probe", kind: "personal", displayName: stamp,
  });
  calls += 1;
  steps.push({ step: "create-room", t: elapsed(started), calls, bytes: room.bytes, status: room.status });
  if (room.status !== 201 && room.status !== 200) {
    confusions.push("Probe owner room creation did not succeed.");
    return finish(outDir, blank(steps, confusions));
  }
  created.rooms.push({ id: roomId, auth: "account", cookie: session.cookie, csrf: session.csrf, binding: session.binding });
  const claim = await postAccount(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims`, session, {
    id: "starter", title: "Starter task", tags: ["starter"],
  });
  calls += 1;
  const proposed = await postAccount(origin, `/api/rooms/${encodeURIComponent(roomId)}/commands`, session, {
    id: randomUUID(), type: "work.proposed",
    data: { workItemId: "starter-item", title: "Starter task", definitionOfDone: "The starter is done", accountableMemberId: "owner" },
  });
  calls += 1;
  steps.push({ step: "prepare-starter", t: elapsed(started), calls, bytes: claim.bytes + proposed.bytes, status: claim.status });
  const invite = await postAccount(origin, `/api/rooms/${encodeURIComponent(roomId)}/agent-invites`, session, {
    profile: "contribute", expiresInMinutes: 30,
  });
  calls += 1;
  steps.push({ step: "mint-code", t: elapsed(started), calls, bytes: invite.bytes, status: invite.status });
  const code = invite.json?.code;
  if (!code) {
    const reason = invite.json?.error?.code === "email_unverified"
      ? "The probe owner account is unverified, so it cannot mint an invite."
      : "The probe owner did not receive an invite code.";
    confusions.push(reason);
    return finish(outDir, blank(steps, confusions));
  }
  const page = await probeFetch(`${origin}/a/${encodeURIComponent(code)}`, { headers: { accept: "*/*" } });
  calls += 1;
  steps.push({ step: "read-page", t: elapsed(started), calls, bytes: page.bytes, status: page.status });
  if (page.status === 404 && page.json?.error?.code === "not_found") {
    return finish(outDir, { status: "not_available", steps, confusions: ["GET /a/<code> is not served on this target."], firstPost: null, firstClose: null, closeReachable: false });
  }
  if (page.status !== 200) {
    confusions.push("The invite page did not answer with the agent text.");
    return finish(outDir, blank(steps, confusions));
  }
  const curls = extractCurls(page.text);
  const redeem = curls.find(curl => curl.url.includes("/agent-invites/redeem"));
  if (!redeem) {
    confusions.push("The invite page did not include a redeem call.");
    return finish(outDir, blank(steps, confusions));
  }
  const redeemed = await executeCurl({ ...redeem, data: (redeem.data || "").replace("<your name>", stamp) }, { target: origin });
  calls += redeemed.calls;
  steps.push({ step: "redeem", t: elapsed(started), calls, bytes: redeemed.bytes, status: redeemed.response.status });
  const joined = redeemed.response.json ?? {};
  const roomToken = joined.mcpToken?.credential;
  if (redeemed.response.status >= 300 || typeof roomToken !== "string") {
    confusions.push("Redeem from the invite page did not return a room token.");
    return finish(outDir, blank(steps, confusions));
  }
  created.identities.push({ id: joined.identityId, secret: roomToken });
  const firstPost = { t: elapsed(started), calls };
  const rest = curls.filter(curl => curl !== redeem && curl.url.includes("/work-claims/"));
  const closeReachable = rest.some(curl => (curl.data || "").includes('"done"'));
  let firstClose = null;
  if (!closeReachable) confusions.push("The invite page did not include a done call.");
  for (const curl of rest) {
    const done = await executeCurl(curl, { secret: roomToken, target: origin });
    calls += done.calls;
    const step = { step: (curl.data || "").includes('"done"') ? "done" : "board", t: elapsed(started), calls, bytes: done.bytes, status: done.response.status };
    steps.push(step);
    if (done.skipped) confusions.push("A page curl pointed off-target and was skipped without credentials.");
    if (!done.skipped && step.step === "done" && done.response.status < 300) firstClose = { t: step.t, calls };
  }
  if (closeReachable && !firstClose) confusions.push("The page's done call did not succeed.");
  return finish(outDir, { steps, firstPost, firstClose, closeReachable, confusions });
}

function blank(steps, confusions) {
  return { steps, firstPost: null, firstClose: null, closeReachable: false, confusions };
}

function finish(outDir, result) {
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeJson(join(outDir, "agent-code.json"), result);
  }
  return result;
}
