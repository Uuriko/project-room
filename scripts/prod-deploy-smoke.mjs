#!/usr/bin/env node
// Post-deploy smoke for the production lane (.github/workflows/deploy-prod.yml
// and rollback-prod.yml). Public endpoints only: no credentials, no writes.
//
//   node scripts/prod-deploy-smoke.mjs --sha <40-hex> \
//     [--origin https://room.trydemigod.com] [--entry https://www.getdasha.com/room] \
//     [--wait-ms 300000]
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
// expected revision (when given), and both signatures verify against the
// pinned key. Pure: no I/O, safe to unit test.
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
    const jwsOk = verifyCardJws({ card, publicKey, jws: card.signatures[0] });
    if (!jwsOk) failures.push("A2A JWS signature does not verify against the pinned key");
  }
  return failures;
}

// Fetch one door's agent card `fetches` times and require EVERY fetch to
// pass checkAgentCard. A single passing fetch is not enough: a traffic split
// between Worker versions serves a mix of signed and unsigned cards (#1524),
// and the deploy must not go green until the split has fully converged.
export async function checkAgentCardDoor({
  url,
  expectedRevision = null,
  fetches = 10,
  gapMs = 1500,
  get: getFn = get,
  sleep: sleepFn = sleep,
  publicKey = AGENT_CARD_PUBLIC_KEY,
  keyId = AGENT_CARD_KEY_ID,
  agentId = AGENT_CARD_AGENT_ID,
}) {
  const failures = [];
  for (let i = 1; i <= fetches; i += 1) {
    const r = await getFn(url);
    if (r.status !== 200 || r.json === null) {
      failures.push(`fetch #${i}: HTTP ${r.status}${r.error ? ` (${r.error})` : ""} — card not served`);
    } else {
      for (const f of checkAgentCard({ card: r.json, expectedRevision, publicKey, keyId, agentId })) {
        failures.push(`fetch #${i}: ${f}`);
      }
    }
    if (i < fetches) await sleepFn(gapMs);
  }
  return failures;
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
  // same relative path.
  for (const door of [origin, entry]) {
    const cardUrl = `${door}/.well-known/agent-card.json`;
    const failures = await checkAgentCardDoor({ url: cardUrl, expectedRevision: sha || null });
    record(`agent-card ${cardUrl}`, failures.length === 0, {
      fetches: 10,
      failures: failures.slice(0, 8),
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
