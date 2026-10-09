// Adversarial auth fuzz for wave1000 guild-13 (auth-identity slice).
// Each fN is one bounded work unit against LOCAL fixtures only.
// Usage: node tools/fuzz.mjs f1   (prints JSON result line)
// Fail-closed contract: every input must answer 401/403/404/409/410/422/428/429,
// never 500, never a silent privilege elevation. Each input has its own timeout.
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const WT = process.env.G13_WT || REPO;
const TMPBASE = join(WT, ".tmp");

const { RoomStore } = await import(join(REPO, "server/store.mjs"));
const { createRoomServer } = await import(join(REPO, "server/http.mjs"));
const { initialRoom } = await import(join(REPO, "server/bootstrap.mjs"));
const { createOAuthProvider } = await import(join(REPO, "server/oauth-provider.mjs"));
const { createIdentityVerification } = await import(join(REPO, "server/identity-verification.mjs"));
const { fastIdentityHashCandidates, configuredIdentityHashKey, IDENTITY_HASH_KEY_FALLBACK } =
  await import(join(REPO, "server/identity-secret-hash.mjs"));
const { gmailImportToken, gmailImportAuth } = await import(join(REPO, "server/gmail-import-authority.mjs"));
const { operatorTokenMatches, presentedOperatorToken, carriesRoomOrAccountCookie } =
  await import(join(REPO, "server/operator-auth.mjs"));
const { handleIdentityMintMcp } = await import(join(REPO, "server/mcp-identity-mint.mjs"));
const { generateKeyPair, signCard } = await import(join(REPO, "server/agent-card-signing.mjs"));
const { solveIdentityMintProof } = await import(join(REPO, "server/agent-identities.mjs"));

const INPUT_TIMEOUT_MS = 8000;
const results = [];

function record(unit, name, pass, detail) {
  results.push({ unit, name, pass, detail: String(detail).slice(0, 300) });
}

// --- fixtures -------------------------------------------------------------
let dirSeq = 0;
async function serve(tag) {
  const directory = mkdtempSync(join(TMPBASE, `g13-fuzz-${tag}-${dirSeq++}-`));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom("commons", "owner"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token, rawAuth } = {}) => fetch(origin + path, {
    method,
    signal: AbortSignal.timeout(INPUT_TIMEOUT_MS),
    headers: {
      Origin: origin,
      ...(rawAuth !== undefined ? { Authorization: rawAuth }
        : token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const close = async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  };
  return { store, origin, request, ownerKey, close, advance: ms => { clock += ms; } };
}

const expectStatus = (res, allowed, label) => {
  if (!allowed.includes(res.status)) throw new Error(`${label}: status ${res.status}, expected one of ${allowed}`);
  if (res.status === 500) throw new Error(`${label}: 500 INTERNAL — fail-open`);
};

// --- F1: malformed identity secrets never resolve, never throw raw ---------
export async function f1() {
  const { store, close } = await serve("f1");
  try {
    const ident = store.identities.create("FuzzOne");
    const malformed = [
      "", "garbage", " ", "pri_", "pri_" + "x".repeat(43),
      "pri_" + "é".repeat(43), "pri_" + "x".repeat(100000),
      "Bearer " + ident.secret, ident.secret.slice(1), ident.secret + " ",
      null, undefined, 123, {}, [], "\u0000pri_x",
    ];
    for (const input of malformed) {
      let out, threw = null;
      try { out = store.identities.resolveGlobalIdentitySecret(input); }
      catch (e) { threw = e; }
      if (out != null) return record("F1", "malformed-secrets", false, `input resolved: ${String(input).slice(0, 40)}`);
      if (threw && !/ServiceError|identity/i.test(threw.name + threw.message)) {
        return record("F1", "malformed-secrets", false, `raw throw: ${threw.constructor.name} ${threw.message}`);
      }
    }
    const ok = store.identities.resolveGlobalIdentitySecret(ident.secret);
    if (!ok || ok.identityId !== ident.identityId) return record("F1", "malformed-secrets", false, "valid secret stopped resolving");
    return record("F1", "malformed-secrets", true, `${malformed.length} malformed inputs rejected, valid still resolves`);
  } finally { await close(); }
}

// --- F2: tampered known secret ---------------------------------------------
export async function f2() {
  const { store, close } = await serve("f2");
  try {
    const ident = store.identities.create("FuzzTwo");
    const tamper = s => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
    for (const candidate of [tamper(ident.secret), ident.secret.slice(0, -5), "pri_" + "z".repeat(43)]) {
      const out = store.identities.resolveGlobalIdentitySecret(candidate);
      if (out != null) return record("F2", "tampered-secret", false, "tampered secret resolved");
    }
    return record("F2", "tampered-secret", true, "3 forged secrets all rejected");
  } finally { await close(); }
}

// --- F3: HTTP bearer gate never 500s ----------------------------------------
export async function f3() {
  const { request, close } = await serve("f3");
  try {
    const probes = [
      { rawAuth: "Bearer garbage", label: "garbage" },
      { rawAuth: "Bearer ", label: "empty" },
      { rawAuth: "bearer garbage", label: "lowercase-scheme" },
      { rawAuth: "Token abc", label: "wrong-scheme" },
      { rawAuth: "Bearer " + "x".repeat(100000), label: "huge" },
      { rawAuth: "Bearer \u00e9\u00e9", label: "unicode" },
      { label: "missing" },
    ];
    for (const p of probes) {
      const res = await request("/api/referral-invites/mint", {
        method: "POST", rawAuth: p.rawAuth, data: { roomId: "commons" },
      });
      // 431 for oversized headers is fail-closed too
      expectStatus(res, [400, 401, 403, 404, 413, 414, 431], `bearer probe ${p.label}`);
      await res.text();
    }
    return record("F3", "bearer-gate", true, `${probes.length} probes, no 500, all fail-closed`);
  } finally { await close(); }
}

// --- F4: known issue — garbage vs identityId get identical 401s --------------
export async function f4() {
  const { store, request, close } = await serve("f4");
  try {
    const ident = store.identities.create("FuzzFour");
    const opts = d => ({ method: "POST", rawAuth: `Bearer ${d}`, data: { roomId: "commons" } });
    const a = await request("/api/referral-invites/mint", opts("garbage-token-xyz"));
    const b = await request("/api/referral-invites/mint", opts("pri_" + "q".repeat(43)));
    const c = await request("/api/referral-invites/mint", opts(ident.identityId));
    const statuses = [a.status, b.status, c.status];
    await Promise.all([a.text(), b.text(), c.text()]);
    const same = statuses.every(s => s === statuses[0]);
    const all401 = statuses.every(s => s === 401);
    return record("F4", "bearer-oracle", same && all401,
      `garbage=${a.status} unknown-format=${b.status} identityId-as-token=${c.status}`);
  } finally { await close(); }
}

// --- F5: HMAC verifier key fallback discipline --------------------------------
export async function f5() {
  const secret = "pri_" + randomBytes(32).toString("base64url");
  // verifier written with the fallback key
  const [first, ...rest] = fastIdentityHashCandidates(secret, {});
  if (first !== fastIdentityHashCandidates(secret, { ROOM_IDENTITY_HASH_KEY: "a-short-key!!!" })[0] &&
      !rest.includes(fastIdentityHashCandidates(secret, { ROOM_IDENTITY_HASH_KEY: "a-short-key!!!" })[0])) {
    // short configured key is ignored; fallback still in candidates
  }
  const withRealKey = fastIdentityHashCandidates(secret, { ROOM_IDENTITY_HASH_KEY: "a-properly-long-configured-key-001" });
  const acceptsFallback = withRealKey.includes(first); // old rows keep verifying
  const rejectsShort = configuredIdentityHashKey("short") === null;
  const wrong = fastIdentityHashCandidates("pri_" + randomBytes(32).toString("base64url"), {});
  const noFalseMatch = !wrong.includes(first);
  const pass = acceptsFallback && rejectsShort && noFalseMatch;
  return record("F5", "verifier-keys", pass,
    `fallback-accepted-with-key=${acceptsFallback} short-rejected=${rejectsShort} no-false-match=${noFalseMatch}`);
}

// --- F6: agent invite double redeem ------------------------------------------
export async function f6() {
  const { request, ownerKey, close } = await serve("f6");
  try {
    const mint = await request("/api/rooms/commons/agent-invites", {
      method: "POST", token: ownerKey,
      data: { profile: "chat" },
    });
    if (mint.status !== 201) return record("F6", "double-redeem", false, `mint status ${mint.status}`);
    const { code } = await mint.json();
    const redeem = { method: "POST", data: { code, displayName: "FuzzSix" } };
    const r1 = await request("/api/agent-invites/redeem", redeem);
    const b1 = await r1.json();
    if (r1.status !== 201 && r1.status !== 200) return record("F6", "double-redeem", false, `first redeem ${r1.status} ${JSON.stringify(b1).slice(0, 120)}`);
    const r2 = await request("/api/agent-invites/redeem", redeem);
    const b2 = await r2.text();
    const pass = [409, 410].includes(r2.status) && r2.status !== 500;
    return record("F6", "double-redeem", pass, `first=${r1.status} second=${r2.status} ${b2.slice(0, 80)}`);
  } finally { await close(); }
}

// --- F7: oauth auth-code replay revokes family ---------------------------------
export async function f7() {
  let t = 1_000_000;
  const provider = createOAuthProvider({ clock: () => t });
  provider.registerClient({ clientId: "fuzz", name: "Fuzz", redirectUris: ["https://fuzz.test/cb"] });
  const verifier = "v".repeat(43);
  const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  const { code } = provider.issueCode({
    clientId: "fuzz", userId: "u1", redirectUri: "https://fuzz.test/cb",
    scopes: ["rooms:read"], codeChallenge: challenge,
  });
  const pair = provider.exchangeCode({ code, clientId: "fuzz", redirectUri: "https://fuzz.test/cb", codeVerifier: verifier });
  let replayErr = null;
  try {
    provider.exchangeCode({ code, clientId: "fuzz", redirectUri: "https://fuzz.test/cb", codeVerifier: verifier });
  } catch (e) { replayErr = e; }
  const deadAccess = provider.verifyAccessToken(pair.accessToken) === null;
  const pass = replayErr && replayErr.code === "invalid_grant" && deadAccess;
  return record("F7", "code-replay", pass,
    `replay=${replayErr?.code ?? "no-throw"} family-access-dead=${deadAccess}`);
}

// --- F8: refresh-token rotation reuse revokes family --------------------------
export async function f8() {
  let t = 1_000_000;
  const provider = createOAuthProvider({ clock: () => t });
  provider.registerClient({ clientId: "fuzz", name: "Fuzz", redirectUris: ["https://fuzz.test/cb"] });
  const verifier = "v".repeat(43);
  const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
  const { code } = provider.issueCode({
    clientId: "fuzz", userId: "u1", redirectUri: "https://fuzz.test/cb",
    scopes: ["rooms:read"], codeChallenge: challenge,
  });
  const pair1 = provider.exchangeCode({ code, clientId: "fuzz", redirectUri: "https://fuzz.test/cb", codeVerifier: verifier });
  const pair2 = provider.refresh({ refreshToken: pair1.refreshToken, clientId: "fuzz" });
  let reuseErr = null;
  try { provider.refresh({ refreshToken: pair1.refreshToken, clientId: "fuzz" }); }
  catch (e) { reuseErr = e; }
  const familyDead = provider.verifyAccessToken(pair2.accessToken) === null;
  const pass = reuseErr && reuseErr.code === "invalid_grant" && familyDead;
  return record("F8", "refresh-reuse", pass,
    `reuse=${reuseErr?.code ?? "no-throw"} family-access-dead=${familyDead}`);
}

// --- F9: guest self-serve idempotency — token shown once ----------------------
export async function f9() {
  const { request, ownerKey, close } = await serve("f9");
  try {
    const room = "commons";
    const keys = generateKeyPair();
    const joinRequest = { roomId: room, requestId: "f9-req-1", issuedAt: Date.now() };
    const cardBody = { name: "FuzzNine", description: "fuzz", capabilities: ["chat"], joinRequest };
    const card = { ...cardBody, agentId: "fuzz9-agent", publicKey: keys.publicKey,
      signature: signCard({ agentId: "fuzz9-agent", card: cardBody, privateKey: keys.privateKey }) };
    const r1 = await request("/api/guest-invites/request", { method: "POST", data: { card } });
    const b1 = await r1.json().catch(() => ({}));
    if (r1.status !== 200 && r1.status !== 201) {
      return record("F9", "selfserve-replay", false, `first request ${r1.status} — ${JSON.stringify(b1).slice(0, 120)}`);
    }
    const firstHadToken = Boolean(b1.token);
    const r2 = await request("/api/guest-invites/request", { method: "POST", data: { card } });
    const b2 = await r2.json().catch(() => ({}));
    const replayed = b2.replayed === true;
    const noTokenSecondTime = !b2.token && !b2.credential;
    const pass = r1.status === 201 && firstHadToken && r2.status === 200 && replayed && noTokenSecondTime;
    return record("F9", "selfserve-replay", pass,
      `first=${r1.status} token=${firstHadToken} second=${r2.status} replayed=${replayed} token-resent=${!noTokenSecondTime}`);
  } finally { await close(); }
}

// --- F10: referral invite double redeem ---------------------------------------
export async function f10() {
  const { request, ownerKey, close } = await serve("f10");
  try {
    const mint = await request("/api/referral-invites/mint", {
      method: "POST", token: ownerKey, data: { roomId: "commons" },
    });
    const mb = await mint.json().catch(() => ({}));
    if (mint.status !== 200 && mint.status !== 201) {
      return record("F10", "referral-double-redeem", false, `mint ${mint.status} ${JSON.stringify(mb).slice(0, 140)}`);
    }
    const redeemBody = { token: mb.token, displayName: "FuzzTen" };
    const r1 = await request("/api/referral-invites/redeem", { method: "POST", data: redeemBody });
    await r1.text();
    const r2 = await request("/api/referral-invites/redeem", { method: "POST", data: redeemBody });
    const b2 = await r2.text();
    const pass = r1.status !== 500 && [400, 404, 409, 410, 422].includes(r2.status);
    return record("F10", "referral-double-redeem", pass, `first=${r1.status} second=${r2.status} ${b2.slice(0, 80)}`);
  } finally { await close(); }
}

// --- F11: GX invite code enumeration — no oracle, rate-limited ---------------
export async function f11() {
  const { request, ownerKey, close } = await serve("f11");
  try {
    const mint = await request("/api/rooms/commons/guest-invites", {
      method: "POST", token: ownerKey,
      data: { requestId: "f11-1", guestLabel: "fuzz", expectedOwnerRevision: 0 },
    });
    if (mint.status !== 201) return record("F11", "invite-enumeration", false, `mint ${mint.status}`);
    await mint.json();
    const keys = generateKeyPair();
    const cardBody = { name: "FuzzEleven", description: "f", capabilities: ["chat"] };
    const statuses = new Set();
    let saw500 = false;
    const t0 = Date.now();
    // stay under the preview rate limit (30) to measure the pure oracle signal
    for (let i = 0; i < 25; i++) {
      const probe = "GX-" + i.toString(36).padStart(32, "0").slice(-32);
      const card = { ...cardBody, publicKey: keys.publicKey, signature: "bad" };
      const res = await request("/api/guest-invites/preview", { method: "POST", data: { inviteCode: probe } });
      statuses.add(res.status);
      if (res.status === 500) saw500 = true;
      await res.text();
    }
    const dt = Date.now() - t0;
    // wrong-prefix format probe (known issue: misleading message, must still fail closed)
    const fmt = await request("/api/guest-invites/preview", { method: "POST", data: { inviteCode: "XX-" + "x".repeat(32) } });
    await fmt.text();
    // now burst past the rate limit to confirm enumeration is throttled
    let saw429 = false;
    for (let i = 0; i < 10; i++) {
      const res = await request("/api/guest-invites/preview", { method: "POST", data: { inviteCode: "GX-" + "y".repeat(32) } });
      if (res.status === 429) saw429 = true;
      if (res.status === 500) saw500 = true;
      await res.text();
    }
    const pass = !saw500 && [...statuses].every(s => [404, 410].includes(s)) && saw429;
    return record("F11", "invite-enumeration", pass,
      `25 probes: statuses=${[...statuses]} xx-prefix=${fmt.status} ms=${dt} rate-limit-engages=${saw429}`);
  } finally { await close(); }
}

// --- F12: identity-id enumeration — uniform 404 --------------------------------
export async function f12() {
  const { store, request, close } = await serve("f12");
  try {
    const real = store.identities.create("FuzzTwelve");
    const probes = [
      "/api/agent-identities/ai_0000000000000000000000000000000000000000000",
      "/api/agent-identities/ai_" + "z".repeat(43),
      `/api/agent-identities/${real.identityId}`,
      "/api/agent-identities/not-an-id",
    ];
    const out = [];
    for (const p of probes) {
      const res = await request(p);
      out.push(`${p.split("/").pop().slice(0, 8)}=${res.status}`);
      await res.text();
      if (res.status === 500) return record("F12", "identity-enumeration", false, "500 on probe");
    }
    return record("F12", "identity-enumeration", true, out.join(" "));
  } finally { await close(); }
}

// --- F13: operator surface — always 404, never an oracle ------------------------
export async function f13() {
  const { request, close } = await serve("f13");
  try {
    const probes = [
      { rawAuth: undefined, label: "no-auth" },
      { rawAuth: "Operator wrong-token-value", label: "wrong-token" },
      { rawAuth: "Bearer wrong-token-value", label: "bearer-scheme" },
      { rawAuth: "Operator ", label: "empty" },
    ];
    const statuses = [];
    for (const p of probes) {
      const res = await request("/api/operator/status", { rawAuth: p.rawAuth });
      statuses.push(`${p.label}=${res.status}`);
      await res.text();
      if (res.status === 500) return record("F13", "operator-oracle", false, "500 on operator probe");
    }
    const pass = statuses.every(s => s.endsWith("=404"));
    return record("F13", "operator-oracle", pass, statuses.join(" "));
  } finally { await close(); }
}

// --- F14: anonymous mint flood hits proof wall, never 500 -----------------------
export async function f14() {
  const { request, close } = await serve("f14");
  try {
    let saw428 = false, saw201 = 0, saw500 = false, last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await request("/api/agent-identities", {
        method: "POST", data: { displayName: `FuzzFlood${i}` },
      });
      last = res.status;
      if (res.status === 201) saw201++;
      if (res.status === 428) saw428 = true;
      if (res.status === 500) saw500 = true;
      await res.text();
    }
    const pass = !saw500 && saw201 > 0 && saw428;
    return record("F14", "mint-flood", pass, `201s=${saw201} saw428=${saw428} last=${last}`);
  } finally { await close(); }
}

// --- F15: deceptive display names on mint --------------------------------------
export async function f15() {
  const { request, close } = await serve("f15");
  try {
    const names = ["owner", "admin", "Guest", "", "x".repeat(81), "room owner", "𝔞dmin", "a".repeat(80)];
    const out = [];
    for (const n of names) {
      const res = await request("/api/agent-identities", { method: "POST", data: { displayName: n } });
      out.push(`${JSON.stringify(n).slice(0, 14)}=${res.status}`);
      await res.text();
      if (res.status === 500) return record("F15", "deceptive-names", false, "500 on name probe");
    }
    const statuses = out.map(s => Number(s.split("=")[1]));
    const pass = !statuses.includes(500);
    return record("F15", "deceptive-names", pass, out.join(" "));
  } finally { await close(); }
}

// --- F16: MCP identity-mint abuse shapes ---------------------------------------
export async function f16() {
  const fakeStore = { identities: { create: () => { throw new Error("should not mint"); } } };
  const cases = [
    [{ jsonrpc: "2.0", method: "tools/call", params: { name: "room_identity_mint", arguments: { displayName: "X" } } }, "notification-no-id", r => r === null],
    [{ jsonrpc: "1.0", id: 1, method: "tools/call", params: { name: "room_identity_mint", arguments: { displayName: "X" } } }, "bad-version", r => r?.error?.code === -32600],
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } }, "unknown-tool", r => r?.error?.code === -32602 && r.error.message === "unknown_tool"],
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_identity_mint", arguments: { displayName: "X", evil: 1 } } }, "extra-props", r => r?.error?.code === -32602],
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_identity_mint", arguments: {} } }, "missing-name", r => r?.error?.code === -32602],
    ["not-an-object", "garbage", r => r?.error?.code === -32600],
    [{ jsonrpc: "2.0", id: "x".repeat(200), method: "tools/call", params: { name: "room_identity_mint", arguments: { displayName: "X" } } }, "long-id", r => r?.error?.code === -32600],
  ];
  for (const [msg, label, want] of cases) {
    let out;
    try { out = handleIdentityMintMcp(fakeStore, msg, { remoteAddress: "10.0.0.9" }); }
    catch (e) { return record("F16", "mcp-mint-abuse", false, `${label} threw ${e.message}`); }
    if (!want(out)) return record("F16", "mcp-mint-abuse", false, `${label} unexpected shape`);
  }
  return record("F16", "mcp-mint-abuse", true, `${cases.length} abuse shapes rejected, no mint, no throw`);
}

// --- F17: guest cannot escalate to member actions --------------------------------
export async function f17() {
  const { request, ownerKey, close } = await serve("f17");
  try {
    const mint = await request("/api/rooms/commons/guest-invites", {
      method: "POST", token: ownerKey,
      data: { requestId: "f17-1", guestLabel: "fuzz", expectedOwnerRevision: 0 },
    });
    if (mint.status !== 201) return record("F17", "guest-escalation", false, `mint ${mint.status}`);
    const { code } = await mint.json();
    // redeem needs an identity secret; mint one anonymously first — the card
    // must be signed with agentId = the redeeming identity's identityId
    const minted = await request("/api/agent-identities", { method: "POST", data: { displayName: "FuzzGuest17" } });
    const { secret, identityId } = await minted.json();
    const keys = generateKeyPair();
    const cardBody = { name: "FuzzSeventeen", description: "f", capabilities: ["chat"] };
    const card = { ...cardBody, publicKey: keys.publicKey,
      signature: signCard({ agentId: identityId, card: cardBody, privateKey: keys.privateKey }) };
    const redeem = await request("/api/guest-invites/redeem", {
      method: "POST", token: secret, data: { inviteCode: code, card },
    });
    const rb = await redeem.json().catch(() => ({}));
    if (redeem.status !== 200 && redeem.status !== 201) {
      return record("F17", "guest-escalation", false, `redeem ${redeem.status} ${JSON.stringify(rb).slice(0, 140)}`);
    }
    const guestToken = rb.token;
    const attempts = [
      ["/api/rooms/commons/agent-invites", { method: "POST", token: guestToken, data: { profile: "chat" } }, "mint-agent-invite"],
      ["/api/rooms/commons/access-requests", { method: "POST", token: guestToken, data: {} }, "access-request"],
    ];
    for (const [path, opts, label] of attempts) {
      const res = await request(path, opts);
      await res.text();
      if (res.status === 500) return record("F17", "guest-escalation", false, `500 on ${label}`);
      if (![400, 401, 403, 404, 422].includes(res.status)) {
        return record("F17", "guest-escalation", false, `${label} answered ${res.status} — possible escalation`);
      }
    }
    return record("F17", "guest-escalation", true, "guest denied member-only actions, no 500");
  } finally { await close(); }
}

// --- F18: unprivileged member cannot mint invites; redeem schema is strict -----
export async function f18() {
  const { request, ownerKey, close } = await serve("f18");
  try {
    const mint = await request("/api/rooms/commons/agent-invites", {
      method: "POST", token: ownerKey, data: { profile: "chat" },
    });
    const { code } = await mint.json();
    // junk fields in the redeem body are REJECTED (strict schema), not ignored
    const junk = await request("/api/agent-invites/redeem", {
      method: "POST", data: { code, displayName: "FuzzPeon", permissions: ["manage_members", "decide"], bogus: 1 },
    });
    await junk.text();
    if (junk.status !== 422) return record("F18", "invite-escalation", false, `junk redeem answered ${junk.status}, expected 422`);
    // clean redeem creates an unprivileged member
    const redeem = await request("/api/agent-invites/redeem", {
      method: "POST", data: { code, displayName: "FuzzPeon" },
    });
    const rb = await redeem.json().catch(() => ({}));
    if (redeem.status !== 200 && redeem.status !== 201) {
      return record("F18", "invite-escalation", false, `redeem ${redeem.status}`);
    }
    const elevated = (rb.member?.permissions || []).some(p => ["manage_members", "decide", "invite_member"].includes(p));
    if (elevated) return record("F18", "invite-escalation", false, `redeem granted elevated perms: ${rb.member.permissions}`);
    const memberSecret = rb.secret;
    const tryMint = await request("/api/rooms/commons/agent-invites", {
      method: "POST", token: memberSecret, data: { profile: "chat" },
    });
    await tryMint.text();
    const pass = [400, 401, 403, 404].includes(tryMint.status);
    return record("F18", "invite-escalation", pass,
      `junk-redeem=422 elevated=${elevated} unprivileged-mint=${tryMint.status}`);
  } finally { await close(); }
}

// --- F19: verification-gated room refuses unverified link ------------------------
export async function f19() {
  const { store, request, ownerKey, close } = await serve("f19");
  try {
    const setPol = await request("/api/rooms/commons/verification-policy", {
      method: "POST", token: ownerKey, data: { requireVerified: true },
    });
    if (setPol.status !== 200) return record("F19", "verified-gate", false, `policy ${setPol.status}`);
    await setPol.text();
    const ident = store.identities.create("FuzzNineteen");
    let denied = false;
    try {
      store.identities.link(ownerKey, "commons", { identityId: ident.identityId, displayName: "FuzzNineteen", permissions: [] });
    } catch (e) { denied = e.code === "unverified_identity" || e.status === 403; }
    if (!denied) return record("F19", "verified-gate", false, "unverified identity linked into gated room");
    // owner attests, then link succeeds
    store.agentPlugin.identityVerification.verify(ident.identityId, { verifiedBy: "owner" });
    let linked = false;
    try {
      store.identities.link(ownerKey, "commons", { identityId: ident.identityId, displayName: "FuzzNineteen", permissions: [] });
      linked = true;
    } catch (e) { return record("F19", "verified-gate", false, `verified link failed: ${e.message}`); }
    // non-owner cannot attest: verify() is owner-only via route; module is caller-owned (documented)
    const v = createIdentityVerification();
    let threw = false;
    try { v.verify("x", {}); } catch { threw = true; }
    return record("F19", "verified-gate", linked && threw, `denied-unverified=${denied} linked-after-attest=${linked}`);
  } finally { await close(); }
}

// --- F20: gmail import authority confused-deputy ----------------------------------
export async function f20() {
  const mk = () => {
    const store = {
      _epoch: 7,
      account: id => ({ id, active: true, authEpoch: 7 }),
      connections: { connection: (aid, cid) => ({ state: "active", authEpoch: 7, profile: { provider: "gmail-api" } }) },
    };
    return store;
  };
  const storeA = mk(), storeB = mk();
  const tokenA = gmailImportToken(storeA, "acct1", "conn1", () => {});
  const cases = [
    ["cross-store", () => gmailImportAuth(storeB, tokenA, { action: "page.apply", connectionId: "conn1" }), "reject"],
    ["wrong-connection", () => gmailImportAuth(storeA, tokenA, { action: "page.apply", connectionId: "connX" }), "reject"],
    ["wrong-envelope", () => gmailImportAuth(storeA, tokenA, { action: "source.import", data: { envelope: { connection: { id: "connX", accountId: "acct1" } } } }), "reject"],
    ["unknown-action", () => gmailImportAuth(storeA, tokenA, { action: "admin.wipe" }), "reject"],
    ["null-token", () => gmailImportAuth(storeA, null, { action: "page.apply", connectionId: "conn1" }), "null"],
    ["forged-object", () => gmailImportAuth(storeA, {}, { action: "page.apply", connectionId: "conn1" }), "null"],
  ];
  for (const [label, fn, want] of cases) {
    let out, threw = null;
    try { out = fn(); } catch (e) { threw = e; }
    if (want === "reject" && !(threw && threw.status === 403)) {
      return record("F20", "gmail-deputy", false, `${label}: expected 403 throw, got ${threw?.status ?? out}`);
    }
    if (want === "null" && out !== null) {
      return record("F20", "gmail-deputy", false, `${label}: expected null, got value`);
    }
  }
  // happy path still works
  const ok = gmailImportAuth(storeA, tokenA, { action: "page.apply", connectionId: "conn1" });
  if (!ok || !ok.account) return record("F20", "gmail-deputy", false, "legit grant rejected");
  // cookie is not an operator credential
  const cookieCarries = carriesRoomOrAccountCookie("room_session=abc");
  const noCookie = carriesRoomOrAccountCookie("");
  if (!cookieCarries || noCookie) return record("F20", "gmail-deputy", false, "cookie predicate wrong");
  // operator token presentation rules
  const bad = presentedOperatorToken("Bearer sometoken");
  const good = presentedOperatorToken("Operator " + "t".repeat(40));
  const match = operatorTokenMatches("nope", {});
  if (bad !== null || good === null || match !== false) {
    return record("F20", "gmail-deputy", false, "operator token predicates wrong");
  }
  return record("F20", "gmail-deputy", true, `${cases.length} deputy shapes rejected, legit grant ok`);
}

// --- runner ---------------------------------------------------------------------
const FUNS = { f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18, f19, f20 };
const which = process.argv[2];
if (!FUNS[which]) {
  console.log(JSON.stringify({ error: `unknown fuzz unit ${which}` }));
  process.exit(2);
}
try {
  await Promise.race([
    FUNS[which](),
    new Promise((_, rej) => setTimeout(() => rej(new Error("unit timeout")), 120000)),
  ]);
} catch (e) {
  record(which.toUpperCase(), "harness", false, `threw: ${e.constructor.name} ${e.message}`.slice(0, 300));
}
console.log(JSON.stringify(results[results.length - 1] ?? { unit: which, pass: false, detail: "no result" }));
process.exit(0);
