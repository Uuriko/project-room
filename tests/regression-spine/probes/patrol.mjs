// Patrol findings via the ORIGINAL HUNT-PATROL-DIAGNOSIS repro, vendored
// unmodified except the tree-root token (probes/vendor/patrol-repro.mjs.txt).
// PATROL-MECH: head-keyed parking — a corrupt-room head move manufactures a
// fresh failing tick. PATROL-GRADE / WATCH-P2: the health view presents the
// failing patrol job as 'disabled' while its error is current.
import { vendorRun, fixed, still, notfiled } from "../lib.mjs";

const id = process.argv[2];
const { code, out, err } = await vendorRun("patrol-repro.mjs.txt", { timeoutMs: 240000 });
if (code !== 0 && !out.includes("tick6 ok:")) notfiled(`vendored patrol repro exited ${code}: ${(err || out).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300)}`);

// Parse the per-tick health blocks the repro prints.
const blocks = [...out.matchAll(/== ([^=]+) ==\n(?:tick result: .*\n)?health: (\{.*\})/g)].map((m) => ({ label: m[1].trim(), health: JSON.parse(m[2]) }));
const tickOk = (re) => { const m = out.match(re); return m ? m[1] : null; };
if (blocks.length < 6) notfiled(`patrol repro output parsed only ${blocks.length} health blocks — output shape drifted`);

if (id === "PATROL-GRADE" || id === "WATCH-P2") {
  const bad = blocks.find((b) => b.health.status === "disabled" && b.health.lastErrorCurrent === true);
  const failing = blocks.find((b) => (b.health.consecutiveFailures ?? 0) > 0);
  if (bad) still(`the health view presents patrol as status='disabled' on a tick where lastErrorCurrent=true (consecutiveFailures=${bad.health.consecutiveFailures}) — the grading precedence grades the config gate before failure recency, so a currently-erroring job reads as switched off (${bad.label})`);
  else if (failing) fixed(`no tick presented the failing job as disabled-with-current-error; failing ticks show status='${failing.health.status}' — grading precedence fixed`);
  else notfiled("no failing tick observed in the vendored repro output");
} else if (id === "PATROL-MECH") {
  // Health blocks in order: A tick1 (fresh park), A tick2 (standing),
  // A tick3 (head moved), A tick4 (standing), tick5 (healthy only), tick6 (corrupt event).
  const cf = blocks.map((b) => b.health.consecutiveFailures ?? 0);
  const t2ok = tickOk(/tick2 ok: (\w+)/);
  const t4ok = tickOk(/tick4 ok: (\w+)/);
  const headMoveManufacturedFailure = cf[2] > cf[1];
  if (headMoveManufacturedFailure && t2ok === "true")
    still(`standing park ticks succeed (tick2 ok=${t2ok}, tick4 ok=${t4ok}) but the head-move tick records a FRESH failure (consecutiveFailures ${cf[1]} -> ${cf[2]}): parking is keyed to (room, head), so every event in the corrupt room earns a new failing tick indefinitely with no repair path`);
  else if (!headMoveManufacturedFailure && cf[2] === 0)
    fixed(`the head-move tick no longer manufactures a fresh failure (consecutiveFailures sequence ${cf.join(",")}) — parking survives head moves or the room is repaired/quarantined`);
  else notfiled(`unrecognised tick pattern: consecutiveFailures sequence ${cf.join(",")}, tick2 ok=${t2ok}, tick4 ok=${t4ok}`);
} else {
  notfiled(`patrol.mjs has no probe for ${id}`);
}
