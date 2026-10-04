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

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
