// Deterministic growth experiments (VL-1a).
//
// Assignment is sha256(experimentId ‖ unitId) mod the arm list, so a cached
// page for one artifact always sees the same arm. There is no storage and
// no event write here. Callers put the returned arm on their own analytics
// props as `variant`. Operator config can force an arm with
// GROWTH_FORCE_ARMS=experiment:arm,experiment:arm. An unknown id or arm in
// that list is ignored and the hash assignment stands.
import { createHash } from "node:crypto";

const ID_SHAPE = /^[a-z][a-z0-9_]{0,40}$/;

export function defineExperiment({ id, arms, metric, minSamplePerArm, startedAt = null }) {
  if (typeof id !== "string" || !ID_SHAPE.test(id)) throw new TypeError("experiment id must be a short lowercase token");
  if (!Array.isArray(arms) || arms.length < 2 || arms.length > 8) throw new TypeError("an experiment needs 2 to 8 arms");
  if (new Set(arms).size !== arms.length) throw new TypeError("experiment arms must be unique");
  for (const arm of arms) {
    if (typeof arm !== "string" || !ID_SHAPE.test(arm)) throw new TypeError("an experiment arm must be a short lowercase token");
  }
  if (typeof metric !== "string" || metric.length === 0) throw new TypeError("experiment metric is required");
  if (!Number.isInteger(minSamplePerArm) || minSamplePerArm < 1) throw new TypeError("minSamplePerArm must be a positive integer");
  if (startedAt !== null && (typeof startedAt !== "string" || startedAt.length === 0)) throw new TypeError("startedAt must be a date string");
  return Object.freeze({ id, arms: Object.freeze([...arms]), metric, minSamplePerArm, startedAt });
}

// Seeded from the virality plan. `bottom` and `run_this` are the control
// arms (index 0). A winner needs at least minSamplePerArm exposures.
const EXPERIMENTS = Object.freeze([
  defineExperiment({
    id: "receipt_cta_copy",
    arms: ["run_this", "start_own"],
    metric: "public_artifact_cta_clicked",
    minSamplePerArm: 400,
    startedAt: "2026-10-02",
  }),
  defineExperiment({
    id: "pr_footer_placement",
    arms: ["bottom", "top"],
    metric: "public_artifact_cta_clicked",
    minSamplePerArm: 400,
    startedAt: "2026-10-02",
  }),
  defineExperiment({
    id: "approval_join_placement",
    arms: ["after", "beside"],
    metric: "public_artifact_cta_clicked",
    minSamplePerArm: 400,
    startedAt: "2026-10-02",
  }),
  defineExperiment({
    id: "template_cta",
    arms: ["use_this", "fork"],
    metric: "template_forked",
    minSamplePerArm: 400,
    startedAt: "2026-10-02",
  }),
]);

const BY_ID = new Map(EXPERIMENTS.map(experiment => [experiment.id, experiment]));

export function listExperiments() {
  return EXPERIMENTS;
}

function forcedArm(experimentId, env) {
  const raw = env?.GROWTH_FORCE_ARMS;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  for (const part of raw.split(",")) {
    const piece = part.trim();
    const split = piece.indexOf(":");
    if (split <= 0) continue;
    if (piece.slice(0, split).trim() !== experimentId) continue;
    return piece.slice(split + 1).trim();
  }
  return null;
}

// Concatenation is the two UTF-8 strings with no separator (the ‖ in the spec).
export function assignVariant(experimentId, unitId, env = process.env) {
  const experiment = BY_ID.get(experimentId);
  if (!experiment) throw new TypeError("unknown experiment");
  if (typeof unitId !== "string" || unitId.length === 0 || unitId.length > 200) throw new TypeError("unitId must be a non-empty string of at most 200 characters");
  const forced = forcedArm(experimentId, env);
  if (forced && experiment.arms.includes(forced)) return forced;
  const digest = createHash("sha256").update(experimentId, "utf8").update(unitId, "utf8").digest();
  const n = digest.readUInt32BE(0);
  return experiment.arms[n % experiment.arms.length];
}
