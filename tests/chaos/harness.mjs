// Minimal deterministic property runner for the chaos suite (tests/chaos/).
//
// Contract:
//   build(seed, rng) -> ctx                      fresh fixture per seed
//   perform(ctx, rng, opIndex) -> string          one random op; returns a log label
//   checkInvariants(ctx, opIndex, label)          throws on invariant violation
//   teardown(ctx)                                 optional, runs once per seed attempt
//
// perform() may throw an error with a string `.code` (ServiceError /
// EscrowError): that is an EXPECTED domain rejection (an illegal transition
// in a random sequence), counted and continued — not a failure. Any other
// throw, from perform() or checkInvariants(), fails the property.
//
// On failure the runner shrinks to the minimal failing op-prefix and prints
// an exact reproduction command. See docs/CHAOS.md.

import { Rng } from "./seeded-random.mjs";

// An error the system under test raises for an illegal-but-well-formed
// operation (ServiceError, EscrowError, ...): identified by a string code,
// never by message text.
export const isExpectedRejection = error =>
  error !== null && typeof error === "object" && typeof error.code === "string";

const envInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error(`CHAOS: ${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
};

export function chaosConfig({ defaultSeeds, defaultOps, defaultSeedBase }) {
  const mode = process.env.CHAOS_MODE ?? "smoke";
  if (mode !== "smoke" && mode !== "full")
    throw new Error(`CHAOS: CHAOS_MODE must be "smoke" or "full", got ${JSON.stringify(mode)}`);
  const full = mode === "full";
  const singleSeedRaw = process.env.CHAOS_SEED;
  const singleSeed = singleSeedRaw === undefined || singleSeedRaw === "" ? null : envInt("CHAOS_SEED", 0);
  return {
    mode,
    seeds: singleSeed === null
      ? envInt("CHAOS_SEEDS", full ? defaultSeeds.full : defaultSeeds.smoke)
      : 1,
    opsPerSeed: envInt("CHAOS_OPS", full ? defaultOps.full : defaultOps.smoke),
    seedBase: envInt("CHAOS_SEED_BASE", defaultSeedBase),
    singleSeed,
  };
}

// One attempt: fresh fixture, `ops` deterministic ops, invariant check after
// every op. Returns counts plus, on failure, the failing op index, the
// phase, the error, and the op log. Always tears down the fixture.
async function attempt({ build, perform, checkInvariants, teardown, seed, ops }) {
  const rng = new Rng(seed);
  const ctx = build(seed, rng);
  const opLog = [];
  let applied = 0;
  let rejected = 0;
  let failure = null;
  try {
    for (let opIndex = 0; opIndex < ops && failure === null; opIndex++) {
      let label;
      try {
        label = perform(ctx, rng, opIndex);
        applied++;
      } catch (error) {
        if (isExpectedRejection(error)) {
          rejected++;
          label = `(rejected ${error.code})`;
        } else {
          failure = { opIndex, opLog: [...opLog], error, phase: "perform" };
          break;
        }
      }
      if (opLog.length < 4096) opLog.push(label);
      else if (opLog.length === 4096) opLog.push("… (log truncated)");
      try {
        checkInvariants(ctx, opIndex, label);
      } catch (error) {
        failure = { opIndex, opLog: [...opLog], error, phase: "check" };
      }
    }
  } finally {
    if (teardown) await teardown(ctx);
  }
  return { applied, rejected, failure };
}

// Shrink: binary-search the smallest op-prefix that still fails. Failure is
// monotone in the prefix length (a failing prefix keeps failing when
// extended), so bisection finds the minimal reproduction.
async function shrink({ build, perform, checkInvariants, teardown, seed, failingOps }) {
  let lo = 1;
  let hi = failingOps; // inclusive: attempt(ops=hi) fails
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const probe = await attempt({ build, perform, checkInvariants, teardown, seed, ops: mid });
    if (probe.failure) {
      best = { ops: mid, failure: probe.failure };
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (best) return best;
  const rerun = await attempt({ build, perform, checkInvariants, teardown, seed, ops: failingOps });
  return { ops: failingOps, failure: rerun.failure };
}

const reproCommand = ({ file, seed, ops }) =>
  `CHAOS_SEED=${seed} CHAOS_OPS=${ops} node --test ${file ?? "<this test file>"}`;

function reportFailure({ name, file, seed, failure, minimal }) {
  const lines = [
    "",
    `CHAOS FAILURE — property "${name}"`,
    `  seed:        ${seed}`,
    `  phase:       ${failure.phase} (op index ${failure.opIndex})`,
    `  error:       ${failure.error?.name ?? "Error"}: ${failure.error?.message ?? failure.error}`,
  ];
  if (failure.error?.code) lines.push(`  error code:  ${failure.error.code}`);
  const useMinimal = minimal && minimal.ops < failure.opIndex + 1;
  const log = useMinimal ? minimal.failure.opLog : failure.opLog;
  if (useMinimal) lines.push(`  shrunk to:  minimal failing prefix of ${minimal.ops} op(s)`);
  lines.push(useMinimal ? "  minimal op log:" : "  op log:");
  for (const [i, label] of log.entries()) lines.push(`    [${i}] ${label}`);
  lines.push(`  reproduce:   ${reproCommand({ file, seed, ops: useMinimal ? minimal.ops : failure.opIndex + 1 })}`);
  lines.push("");
  console.log(lines.join("\n"));
}

export async function runProperty({
  name,
  file = null,
  build,
  perform,
  checkInvariants,
  teardown = null,
  defaultSeeds,
  defaultOps,
  defaultSeedBase,
}) {
  const config = chaosConfig({ defaultSeeds, defaultOps, defaultSeedBase });
  const plan = [];
  for (let s = 0; s < config.seeds; s++) plan.push(config.singleSeed ?? (config.seedBase + s));

  let applied = 0;
  let rejected = 0;
  const failures = [];
  for (const seed of plan) {
    const result = await attempt({ build, perform, checkInvariants, teardown, seed, ops: config.opsPerSeed });
    applied += result.applied;
    rejected += result.rejected;
    if (result.failure) failures.push({ seed, failure: result.failure });
  }

  if (failures.length > 0) {
    for (const { seed, failure } of failures) {
      const minimal = await shrink({ build, perform, checkInvariants, teardown, seed, failingOps: failure.opIndex + 1 });
      reportFailure({ name, file, seed, failure, minimal });
    }
    throw new Error(
      `chaos property "${name}" FAILED on ${failures.length}/${plan.length} seed(s) — seed reproduction printed above`
    );
  }
  console.log(
    `chaos ok: ${name} — ${plan.length} seed(s) x ${config.opsPerSeed} ops, ` +
    `${applied} applied, ${rejected} expected rejections, 0 failures [mode=${config.mode}]`
  );
  return { seeds: plan.length, applied, rejected, mode: config.mode };
}
