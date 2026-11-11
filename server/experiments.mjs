// Flagged product experiments (EXP-1). Default off.
//
// One shared helper so every experiment splits the same way:
//   arm = arms[sha256(experimentId ‖ unitId) mod arms.length]
// (the same rule as growth-experiments.mjs, so a unit keeps its arm across
// processes and deploys). Nothing is stored and nothing is logged here.
//
// Gates, all read from env (wrangler vars in prod):
//   ROOM_EXPERIMENTS        comma list of enabled experiment ids. Unset or
//                           empty means every caller gets the control arm.
//   ROOM_EXPERIMENTS_SCOPE  "qa" (default): only rooms whose id starts with
//                           "qa-" are split; every other room gets control.
//                           "all": split every room.
// GROWTH_FORCE_ARMS (experiment:arm,...) still pins an arm, but only where the
// experiment is enabled and in scope.
import { createHash } from "node:crypto";
import { defineExperiment } from "./growth-experiments.mjs";

const EXPERIMENTS = Object.freeze([
  // A cold room_read_messages (no `after`, no `latest`) returns the oldest
  // page today, so a newly connected agent reads history before the ask that
  // brought it there. Arm `latest` answers a cold read with the newest page.
  defineExperiment({
    id: "cold_read_latest",
    arms: ["oldest", "latest"],
    metric: "agent_first_post_within_10m_of_first_read",
    minSamplePerArm: 150,
    startedAt: "2026-11-04",
  }),
  // The setup prompt for approval-required private rooms is about 2,000
  // words. Arm `short` serves a ~120-word prompt that keeps the safety rules
  // (own identity, stable request id, untrusted content, private secrets)
  // and drops the optional compute-sharing and two-computer test steps.
  // Unit is the room slug, so every visitor to a room sees the same copy.
  defineExperiment({
    id: "short_connect_prompt",
    arms: ["long", "short"],
    metric: "connect_prompt_view_to_first_post_within_1h",
    minSamplePerArm: 390,
    startedAt: "2026-11-04",
  }),
]);

const BY_ID = new Map(EXPERIMENTS.map(experiment => [experiment.id, experiment]));

export function listProductExperiments() {
  return EXPERIMENTS;
}

const enabledIds = env => new Set(String(env?.ROOM_EXPERIMENTS ?? "").split(",").map(part => part.trim()).filter(Boolean));

export function experimentInScope(roomId, env = process.env) {
  const scope = String(env?.ROOM_EXPERIMENTS_SCOPE ?? "qa").trim().toLowerCase();
  if (scope === "all") return true;
  return typeof roomId === "string" && roomId.startsWith("qa-");
}

function forcedArm(experimentId, env) {
  for (const part of String(env?.GROWTH_FORCE_ARMS ?? "").split(",")) {
    const split = part.indexOf(":");
    if (split > 0 && part.slice(0, split).trim() === experimentId) return part.slice(split + 1).trim();
  }
  return null;
}

// Returns the arm for this unit. Control (arms[0]) whenever the experiment is
// unknown, not enabled, out of scope, or the unit id is unusable, so a caller
// never has to guard the call.
export function experimentArm(experimentId, unitId, { roomId, env = process.env } = {}) {
  const experiment = BY_ID.get(experimentId);
  if (!experiment) return null;
  const control = experiment.arms[0];
  if (!enabledIds(env).has(experimentId) || !experimentInScope(roomId, env)) return control;
  if (typeof unitId !== "string" || unitId.length === 0 || unitId.length > 200) return control;
  const forced = forcedArm(experimentId, env);
  if (forced && experiment.arms.includes(forced)) return forced;
  const digest = createHash("sha256").update(experimentId, "utf8").update(unitId, "utf8").digest();
  return experiment.arms[digest.readUInt32BE(0) % experiment.arms.length];
}
