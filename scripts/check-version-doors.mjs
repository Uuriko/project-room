// Version door check. Zero dependencies.
//
// /api/version is answered inside the Durable Object; /api/version/worker is
// answered from Worker module scope (cloudflare/room.mjs). After a deploy the
// Worker flips at once while an already-running DO instance can keep serving
// the previous revision for up to about a minute (observed twice: worker on
// a21c2364, /api/version still on cbd4ee5e). Reading one door and calling it
// "what is live" is therefore wrong during that window. This reads both.
//
// States for a target sha:
//   converged     both doors report sha
//   do-stale      worker reports sha, the Durable Object door does not (rollout in progress)
//   worker-stale  the DO door reports sha, the worker door does not
//   other         neither door reports sha (a different revision, or unreachable)
//
// CLI: node scripts/check-version-doors.mjs --origin URL --sha SHA [--wait-ms 0] [--poll-ms 10000]
// Confirm live after a deploy: npm run confirm-live -- <sha> [--wait-ms 600000]
// (origin defaults to production, a bare first argument is the sha, and the
// sha may be a 7+ hex prefix).
// Waits up to --wait-ms for "converged", prints JSON, exits 0 converged,
// 3 do-stale, 4 worker-stale, 5 other.
import { fileURLToPath } from "node:url";

export const DOORS = Object.freeze({ do: "/api/version", worker: "/api/version/worker" });

// sha may be the full 40-hex revision or a prefix of at least 7 hex digits
// (the short form a PR page or `git log --oneline` shows).
export const matchesRevision = (rev, sha) => typeof rev === "string" && typeof sha === "string"
  && /^[0-9a-f]{7,40}$/i.test(sha) && rev.toLowerCase().startsWith(sha.toLowerCase());

export function classifyDoors({ sha, doRev, workerRev }) {
  const onDo = matchesRevision(doRev, sha), onWorker = matchesRevision(workerRev, sha);
  if (onDo && onWorker) return "converged";
  if (onWorker) return "do-stale";
  if (onDo) return "worker-stale";
  return "other";
}

async function readDoor(origin, path, fetchImpl) {
  try {
    const res = await fetchImpl(`${origin}${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 project-room-version-doors", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const rev = (await res.json())?.sourceRevision;
    return typeof rev === "string" && rev ? rev : null;
  } catch { return null; }
}

export async function readDoors(origin, fetchImpl = fetch) {
  const [doRev, workerRev] = await Promise.all([
    readDoor(origin, DOORS.do, fetchImpl), readDoor(origin, DOORS.worker, fetchImpl)
  ]);
  return { doRev, workerRev };
}

// Poll until both doors report `sha` or the window closes; returns the last read.
export async function waitDoors({ origin, sha, waitMs = 0, pollMs = 10000, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const seen = await readDoors(origin, fetchImpl);
    const state = classifyDoors({ sha, ...seen });
    if (state === "converged" || Date.now() >= deadline) return { state, ...seen };
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

const EXIT = { converged: 0, "do-stale": 3, "worker-stale": 4, other: 5 };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const origin = opt("--origin", "https://room.trydemigod.com");
  const sha = (opt("--sha") ?? (args[0] && !args[0].startsWith("--") ? args[0] : "")).toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    console.error("usage: check-version-doors.mjs [--origin URL] --sha <7-40 hex> [--wait-ms N] [--poll-ms N]");
    process.exit(2);
  }
  const result = await waitDoors({ origin: origin.replace(/\/$/, ""), sha, waitMs: Number(opt("--wait-ms", 0)), pollMs: Number(opt("--poll-ms", 10000)) });
  console.log(JSON.stringify({ sha, origin, ...result, label: result.state === "do-stale" ? "DO still on old revision" : result.state }));
  if (result.state === "do-stale") console.error(`DO still on old revision: worker reports ${sha}, ${DOORS.do} reports ${result.doRev ?? "nothing"}`);
  process.exit(EXIT[result.state]);
}
