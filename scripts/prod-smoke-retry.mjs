// A failed smoke is not automatically propagation. Never replace its report.
import { createHash } from "node:crypto";
import { timeoutOnlyEvidence } from "./readiness-recovery-hold.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function propagationRetry(report, { sha, origin, entry }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "") || report?.ok !== false || report.sha !== sha
      || report.origin !== origin || report.entry !== entry || !Array.isArray(report.checks)) return false;
  const expected = [origin, entry].flatMap(door => [
    ...["/api/version", "/api/version/worker"].map(path => `version ${door}${path}`),
    `health ${door}/api/health`, `ready ${door}/api/ready`,
    ...["/terms", "/privacy", "/"].map(path => `page ${door}${path}`),
    `agent-card ${door}/.well-known/agent-card.json`,
  ]);
  if (report.checks.length !== expected.length || new Set(report.checks.map(c => c?.name)).size !== expected.length) return false;
  let failed = 0;
  for (const check of report.checks) {
    if (!expected.includes(check?.name) || typeof check.pass !== "boolean") return false;
    if (check.pass) continue;
    failed++;
    if (check.name.startsWith("version ") && check.status === 200
        && /^[0-9a-f]{40}$/.test(check.got ?? "") && check.got !== sha) continue;
    if (check.name.startsWith("agent-card ") && check.retryKind === "verified-stale-card") continue;
    return false;
  }
  return failed > 0;
}

// Reuse the recovery hold's exact report contract. This locally computed digest
// binds validation to these bytes; it is not independent provenance or a pass.
export function readinessRetry(report, options) {
  const raw = JSON.stringify(report);
  return typeof raw === "string" && timeoutOnlyEvidence(raw, {
    ...options, digest: createHash("sha256").update(raw).digest("hex")
  });
}

// A readiness timeout is inconclusive, not proof of propagation. Observe only
// the existing 150s retry budget, at 10s cadence, then require a full strict
// smoke again. Never broaden the endpoint's own 1s deadline or accept a cached
// health result. A revision change or any other failure stops observation.
export async function pollReadiness({ sha, origin, entry, waitMs = 150000, fetchImpl = fetch,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), progress = console.error }) {
  const deadline = now() + Math.min(150000, Math.max(0, waitMs));
  const doors = [origin, entry];
  const read = async url => {
    try {
      const response = await fetchImpl(url, { redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - now()))),
        headers: { "User-Agent": "Mozilla/5.0 project-room-deploy-smoke", "Cache-Control": "no-cache" } });
      return { status: response.status, body: await response.json() };
    } catch { return { status: 0, body: null }; }
  };
  while (now() < deadline) {
    await sleep(Math.min(10000, deadline - now()));
    if (now() >= deadline) return false;
    const versions = await Promise.all(doors.flatMap(door => ["/api/version", "/api/version/worker"].map(path => read(door + path))));
    if (now() >= deadline || !versions.every(r => r.status === 200 && r.body?.sourceRevision === sha)) {
      progress("Readiness recheck stopped: target revision no longer confirmed within budget");
      return false;
    }
    const responses = await Promise.all(doors.map(door => read(door + "/api/ready")));
    const states = responses.map(({ status, body }) => {
      if (status === 200 && body?.status === "ready" && body.do?.status === "ok"
          && body.emailVerification === "enforced" && body.emailVerificationScope === "durable-object") return "ready";
      if (status === 503 && body?.status === "degraded" && body.do?.status === "timeout" && body.do.timeoutMs === 1000
          && [undefined, "unknown", "enforced"].includes(body.emailVerification)
          && [undefined, "unknown", "durable-object"].includes(body.emailVerificationScope)) return "timeout";
      return "invalid";
    });
    progress(`Readiness observation: ${states.join(", ")}; ${Math.max(0, deadline - now())}ms remaining`);
    if (now() >= deadline || states.includes("invalid")) return false;
    if (states.every(state => state === "ready")) return true;
  }
  return false;
}

export async function pollConvergence({ sha, origin, entry, waitMs = 150000, fetchImpl = fetch,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), progress = console.error }) {
  const deadline = now() + waitMs;
  const urls = [origin, entry].flatMap(door => ["/api/version", "/api/version/worker"].map(path => `${door}${path}`));
  while (now() < deadline) {
    const states = await Promise.all(urls.map(async url => {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - now()))),
          headers: { "User-Agent": "Mozilla/5.0 project-room-deploy-smoke", "Cache-Control": "no-cache" } });
        const revision = (await response.json())?.sourceRevision;
        return response.status === 200 && /^[0-9a-f]{40}$/.test(revision ?? "") ? revision === sha ? "target" : "stale" : "invalid";
      } catch { return "unavailable"; }
    }));
    progress(`Smoke propagation: ${states.join(", ")}; ${Math.max(0, deadline - now())}ms remaining`);
    if (states.some(state => state === "invalid" || state === "unavailable")) return false;
    if (states.every(state => state === "target")) return now() <= deadline;
    if (now() < deadline) await sleep(Math.min(10000, deadline - now()));
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = name => args[args.indexOf(name) + 1];
  const options = { sha: opt("--sha"), origin: opt("--origin"), entry: opt("--entry") };
  try {
    const report = JSON.parse(readFileSync(args[0], "utf8"));
    if (readinessRetry(report, options)) {
      console.error("Smoke failed only DO readiness timeout; bounded observations for at most 150s before full strict retry, original failure retained");
      if (!await pollReadiness(options)) throw new Error("readiness unproven within budget; refusing retry");
    } else {
      if (!propagationRetry(report, options)) throw new Error("not exclusively verified propagation or readiness timeout; refusing retry");
      console.error("Smoke failed only verified propagation checks; observing convergence for at most 150s before strict retry");
      if (!await pollConvergence(options)) throw new Error("convergence unproven within budget; refusing retry");
    }
  } catch (error) {
    console.error(`Smoke retry refused: ${error instanceof SyntaxError ? "malformed report" : error.message}`);
    process.exitCode = 1;
  }
}
