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
// Waits up to --wait-ms for "converged", prints JSON, exits 0 converged,
// 3 do-stale, 4 worker-stale, 5 other.
import { fileURLToPath } from "node:url";

export const DOORS = Object.freeze({ do: "/api/version", worker: "/api/version/worker" });

export function classifyDoors({ sha, doRev, workerRev }) {
  if (doRev === sha && workerRev === sha) return "converged";
  if (workerRev === sha) return "do-stale";
  if (doRev === sha) return "worker-stale";
  return "other";
}

// Returns { rev, status }. A non-2xx answer keeps its HTTP status so "the door
// answered 403" (a WAF or bot rule on the caller's network) is not reported the
// same as "the door is on another revision". Dot's 403 on /api/version looked
// like a stale prod SHA for exactly that reason.
async function readDoor(origin, path, fetchImpl) {
  try {
    const res = await fetchImpl(`${origin}${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 project-room-version-doors", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { rev: null, status: res.status };
    const rev = (await res.json())?.sourceRevision;
    return { rev: typeof rev === "string" && rev ? rev : null, status: res.status };
  } catch { return { rev: null, status: 0 }; }
}

export async function readDoors(origin, fetchImpl = fetch) {
  const [doDoor, workerDoor] = await Promise.all([
    readDoor(origin, DOORS.do, fetchImpl), readDoor(origin, DOORS.worker, fetchImpl)
  ]);
  return { doRev: doDoor.rev, workerRev: workerDoor.rev, doStatus: doDoor.status, workerStatus: workerDoor.status };
}

// Names the cause when a door could not be read at all, so a blocked caller is not mistaken for drift.
export function unreadableDoors({ doStatus, workerStatus }) {
  const bad = [["DO door", doStatus], ["worker door", workerStatus]].filter(([, status]) => status !== 200 && status !== undefined);
  return bad.map(([name, status]) => `${name}: ${status === 0 ? "no response" : `HTTP ${status}`}`);
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
  const origin = opt("--origin");
  const sha = opt("--sha");
  if (!origin || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
    console.error("usage: check-version-doors.mjs --origin URL --sha <40-hex> [--wait-ms N] [--poll-ms N]");
    process.exit(2);
  }
  const result = await waitDoors({ origin: origin.replace(/\/$/, ""), sha, waitMs: Number(opt("--wait-ms", 0)), pollMs: Number(opt("--poll-ms", 10000)) });
  const unreadable = unreadableDoors(result);
  console.log(JSON.stringify({ sha, origin, ...result, label: result.state === "do-stale" ? "DO still on old revision" : result.state, ...(unreadable.length ? { unreadable } : {}) }));
  if (unreadable.length) console.error(`Could not read ${unreadable.join("; ")}. A non-200 here is a blocked or failed read, not proof of which revision is live.`);
  if (result.state === "do-stale") console.error(`DO still on old revision: worker reports ${sha}, ${DOORS.do} reports ${result.doRev ?? "nothing"}`);
  process.exit(EXIT[result.state]);
}
