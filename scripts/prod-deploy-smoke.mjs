#!/usr/bin/env node
// Post-deploy smoke for the production lane (.github/workflows/deploy-prod.yml
// and rollback-prod.yml). Public endpoints only: no credentials, no writes.
//
//   node scripts/prod-deploy-smoke.mjs --sha <40-hex> \
//     [--origin https://room.trydemigod.com] [--entry https://www.getdasha.com/room] \
//     [--wait-ms 300000] \
//     [--agent-card-public-key <base64>] [--agent-card-key-id <id>] \
//     [--agent-card-agent-id <id>] [--agent-card-fetches 10] \
//     [--agent-card-wait-ms 90000]
//
// Test-only knobs (env fallbacks SMOKE_AGENT_CARD_PUBLIC_KEY,
// SMOKE_AGENT_CARD_KEY_ID, SMOKE_AGENT_CARD_AGENT_ID, SMOKE_AGENT_CARD_FETCHES,
// SMOKE_AGENT_CARD_WAIT_MS): let the test suite inject its own signing key,
// shrink the repeated card fetches and the propagation window. The deploy
// pipeline never sets them, so production always pins the real key, runs the
// full fetch count and the full propagation window.
//
// Waits until /api/version and /api/version/worker report --sha on both the
// canonical host and the public entry (edge propagation takes a few seconds),
// then requires /api/health status "ok", /api/ready status "ready", and HTTP
// 200 for /terms, /privacy and / on both doors. Prints one JSON report;
// exits 1 on any failure.
// Without --sha it skips the revision wait (used after a rollback, where the
// old revision is the expected one and is checked by the caller), but still
// checks health, readiness and pages on both doors.
//
// Agent-card consistency (#1524): the version wait only requires each door to
// report --sha once, so a gradual Worker rollout / traffic split can pass it
// while most fetches still hit the previous (possibly unsigned) version —
// QA-b saw the card signed on 1 of 15 fetches. After the other checks, the
// smoke fetches /.well-known/agent-card.json repeatedly on both doors and
// requires EVERY fetch to carry a signature that verifies against the pinned
// key (and binds the deployed revision when --sha is given). Any unsigned or
// flapping state fails the smoke, and the deploy pipeline rolls back.
//
// Propagation tolerance (deploy-prod run 37392991641): the card is baked into
// the Worker bundle and served from module scope (cloudflare/edge-public.mjs,
// Cache-Control: no-store, never cached at the edge), so a card naming the
// previous revision means the request hit a Worker isolate still running the
// previous version. Cloudflare takes seconds to retire those after
// `wrangler deploy`: run 37392991641 saw fetches #1-#6 on the room host (about
// 17-26s after the deploy) carry the previous build's card, then #7-#10 and
// all 10 entry fetches carry the new one. The door check therefore waits up to
// --agent-card-wait-ms for --agent-card-fetches CONSECUTIVE passing fetches.
// A card served by a previous build resets the streak; it is never counted as
// a pass. A card served by the target build that fails any check fails the
// door at once (no retry), and a door that has not converged when the window
// closes fails, so a persistent mismatch still rolls the deploy back.
import { pathToFileURL } from "node:url";
import { verifyCardJws, verifyCardSignature } from "../server/agent-card-signing.mjs";
import {
  AGENT_CARD_AGENT_ID,
  AGENT_CARD_KEY_ID,
  AGENT_CARD_PUBLIC_KEY,
} from "../deploy/agent-card-key.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const sha = opt("sha");
const origin = opt("origin", "https://room.trydemigod.com").replace(/\/$/, "");
const entry = opt("entry", "https://www.getdasha.com/room").replace(/\/$/, "");
const waitMs = Number(opt("wait-ms", "300000"));
// Test seams (#1524): the deploy pipeline never sets these, so production
// always verifies against the pinned key with the full fetch count. Tests
// inject their own keypair through these knobs — they cannot sign for the
// production pinned key — and shrink the fetch count so the CLI finishes
// inside the test timeout. Flags win; env vars are the fallback the
// workflow-pipeline test uses (it runs the literal deploy step, so it can
// only inject through the environment).
const agentCardPublicKey = opt("agent-card-public-key", process.env.SMOKE_AGENT_CARD_PUBLIC_KEY || AGENT_CARD_PUBLIC_KEY);
const agentCardKeyId = opt("agent-card-key-id", process.env.SMOKE_AGENT_CARD_KEY_ID || AGENT_CARD_KEY_ID);
const agentCardAgentId = opt("agent-card-agent-id", process.env.SMOKE_AGENT_CARD_AGENT_ID || AGENT_CARD_AGENT_ID);
const agentCardFetches = Math.max(1, Number(opt("agent-card-fetches", process.env.SMOKE_AGENT_CARD_FETCHES || "10")) || 10);
const agentCardWaitRaw = Number(opt("agent-card-wait-ms", process.env.SMOKE_AGENT_CARD_WAIT_MS || "90000"));
const agentCardWaitMs = Number.isFinite(agentCardWaitRaw) && agentCardWaitRaw >= 0 ? agentCardWaitRaw : 90000;
if (sha && !/^[0-9a-f]{40}$/.test(sha)) {
  console.error("prod-deploy-smoke: --sha must be a full 40-character lowercase hex commit");
  process.exit(2);
}

// Cloudflare's bot rules treat a bare client differently from a browser.
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 project-room-deploy-smoke";
const get = async (url, accept = "application/json") => {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, json: null, ms: Date.now() - started, error: String(error?.message ?? error) };
  }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Deploy-time consistency check for one served agent card (#1524). Returns
// the list of failures; an empty list means the card is signed, binds the
// expected revision (when given), and the house signature plus EVERY JWS
// entry in card.signatures verify against the pinned key. Pure: no I/O,
// safe to unit test.
export function checkAgentCard({ card, expectedRevision = null, publicKey = AGENT_CARD_PUBLIC_KEY, keyId = AGENT_CARD_KEY_ID, agentId = AGENT_CARD_AGENT_ID }) {
  const failures = [];
  if (card === null || typeof card !== "object" || Array.isArray(card)) {
    return ["served card is not a JSON object"];
  }
  if (card.signed === false) {
    failures.push("card is marked signed:false (served unsigned)");
  }
  if (typeof card.cardSignature !== "string" || card.cardSignature.length === 0) {
    failures.push("card carries no cardSignature envelope");
  }
  if (!Array.isArray(card.signatures) || card.signatures.length === 0) {
    failures.push("card carries no signatures[] JWS array");
  }
  if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== "") {
    if (card.signedRevision !== expectedRevision) {
      failures.push(`card signedRevision ${JSON.stringify(card.signedRevision)} does not match deployed revision ${expectedRevision}`);
    }
  }
  if (card.publicKey !== publicKey) {
    failures.push("card publicKey does not match the pinned key");
  }
  if (card.keyId !== keyId) {
    failures.push(`card keyId ${JSON.stringify(card.keyId)} does not match the pinned key id ${keyId}`);
  }
  if (card.signatureAgentId !== agentId) {
    failures.push(`card signatureAgentId ${JSON.stringify(card.signatureAgentId)} does not match ${agentId}`);
  }
  if (typeof card.cardSignature === "string" && card.cardSignature.length > 0) {
    const houseOk = verifyCardSignature({ agentId, card, publicKey, signature: card.cardSignature });
    if (!houseOk) failures.push("house cardSignature does not verify against the pinned key");
  }
  if (Array.isArray(card.signatures) && card.signatures.length > 0) {
    // Prod cards carry more than one JWS entry (house + JWS both verify), so
    // verify EVERY entry, not just signatures[0]: a broken second signature
    // must not pass silently (room seq 3239, carried over from TB-14).
    card.signatures.forEach((jws, i) => {
      const jwsOk = verifyCardJws({ card, publicKey, jws });
      if (!jwsOk) failures.push(`A2A JWS signatures[${i}] does not verify against the pinned key`);
    });
  }
  return failures;
}

// Which build served this card? The card names its own build in
// deployed.revision, and signedRevision is only attached when the signature
// covers the serving build's revision (deploy/agent-discovery.mjs). Pure.
export function cardServedByRevision(card, expectedRevision) {
  if (!expectedRevision || card === null || typeof card !== "object") return false;
  return card.deployed?.revision === expectedRevision || card.signedRevision === expectedRevision;
}

// Fetch one door's agent card until `fetches` CONSECUTIVE fetches pass
// checkAgentCard, within `waitMs`. A single passing fetch is not enough: a
// traffic split or a version still propagating serves a mix of cards
// (#1524, run 37392991641), and the deploy must not go green until the door
// has converged. Failing fetches from a previous build (propagation) reset
// the streak and are retried until the window closes; a failing card served
// by the target build fails at once. Without expectedRevision (post-rollback
// mode) every failure is treated as not-yet-converged until the window
// closes. Returns the failure list (empty = converged); when `stats` is
// given it is filled with attempt counts for the report.
export async function checkAgentCardDoor({
  url,
  expectedRevision = null,
  fetches = 10,
  gapMs = 1500,
  waitMs = 90000,
  get: getFn = get,
  sleep: sleepFn = sleep,
  now = Date.now,
  publicKey = AGENT_CARD_PUBLIC_KEY,
  keyId = AGENT_CARD_KEY_ID,
  agentId = AGENT_CARD_AGENT_ID,
  stats = null,
}) {
  const started = now();
  const deadline = started + Math.max(0, waitMs);
  let streak = 0;
  let attempt = 0;
  let staleFetches = 0;
  const pending = [];
  const done = (failures, converged) => {
    if (stats) Object.assign(stats, { attempts: attempt, staleFetches, converged, elapsedMs: now() - started });
    return failures;
  };
  for (;;) {
    attempt += 1;
    const r = await getFn(url);
    let failures;
    let target = false;
    if (r.status !== 200 || r.json === null) {
      failures = [`HTTP ${r.status}${r.error ? ` (${r.error})` : ""} — card not served`];
    } else {
      failures = checkAgentCard({ card: r.json, expectedRevision, publicKey, keyId, agentId });
      target = cardServedByRevision(r.json, expectedRevision);
    }
    if (failures.length === 0) {
      streak += 1;
      if (streak >= fetches) return done([], true);
    } else {
      const labelled = failures.map(f => `fetch #${attempt}: ${f}`);
      // The target build itself served a bad card: no amount of waiting fixes it.
      if (target) return done(labelled, false);
      streak = 0;
      staleFetches += 1;
      pending.push(...labelled);
      if (now() >= deadline) {
        return done([...pending.slice(-8), `not converged: ${fetches} consecutive passing fetches not reached within ${waitMs}ms (${staleFetches} failing of ${attempt} fetches)`], false);
      }
    }
    await sleepFn(gapMs);
  }
}

async function main() {
  const report = { ok: true, sha: sha || null, origin, entry, checks: [] };
  const record = (name, pass, detail) => {
    report.checks.push({ name, pass, ...detail });
    if (!pass) report.ok = false;
  };

  if (sha) {
    const doors = [`${origin}/api/version`, `${origin}/api/version/worker`, `${entry}/api/version`, `${entry}/api/version/worker`];
    const deadline = Date.now() + waitMs;
    const last = {};
    for (;;) {
      const results = await Promise.all(doors.map(get));
      results.forEach((r, i) => { last[doors[i]] = r.json?.sourceRevision ?? `http ${r.status}`; });
      if (doors.every(d => last[d] === sha) || Date.now() > deadline) break;
      await sleep(10000);
    }
    for (const d of doors) record(`version ${d}`, last[d] === sha, { got: last[d] });
  }

  for (const door of [origin, entry]) {
    const health = await get(`${door}/api/health`);
    record(`health ${door}/api/health`, health.status === 200 && health.json?.status === "ok", { status: health.status, body: health.json?.status ?? null });
    const ready = await get(`${door}/api/ready`);
    record(`ready ${door}/api/ready`, ready.status === 200 && ready.json?.status === "ready", { status: ready.status, body: ready.json?.status ?? null });
    for (const page of ["/terms", "/privacy", "/"]) {
      const r = await get(`${door}${page}`, "text/html");
      record(`page ${door}${page}`, r.status === 200, { status: r.status });
    }
  }

  // #1524: repeated signed-card assertion on both doors. The entry door is
  // the /room-prefixed public door, so its A2A card twin resolves at the
  // same relative path. Key and fetch count come from the test seams above;
  // production always uses the pinned key and the full fetch count.
  for (const door of [origin, entry]) {
    const cardUrl = `${door}/.well-known/agent-card.json`;
    const stats = {};
    const failures = await checkAgentCardDoor({
      url: cardUrl,
      expectedRevision: sha || null,
      fetches: agentCardFetches,
      waitMs: agentCardWaitMs,
      publicKey: agentCardPublicKey,
      keyId: agentCardKeyId,
      agentId: agentCardAgentId,
      stats,
    });
    record(`agent-card ${cardUrl}`, failures.length === 0, {
      fetches: agentCardFetches,
      waitMs: agentCardWaitMs,
      ...stats,
      failures: failures.slice(0, 9),
      failureCount: failures.length,
    });
  }

  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    code => process.exit(code),
    error => { console.error(`prod-deploy-smoke: ${error?.message ?? error}`); process.exit(1); },
  );
}
