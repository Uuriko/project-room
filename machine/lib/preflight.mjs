import { measureHost, onAcPower } from "./measure.mjs";
import versions from "../versions.json" with { type: "json" };

// No password. Reports the measured gap when disk is short. Refuses when
// the machine is not Apple Silicon, not macOS 14 or newer, or not on AC.
export async function preflight() {
  const facts = await measureHost();
  const problems = [];
  if (facts.arch !== "arm64" && facts.arch !== "aarch64") {
    problems.push(`Apple Silicon is required (measured arch: ${facts.arch}).`);
  }
  if (facts.macos === "not measured") problems.push("macOS version was not measured. macOS 14 or newer is required.");
  else {
    const major = Number(String(facts.macos).split(".")[0]);
    if (!Number.isFinite(major) || major < 14) problems.push(`macOS 14 or newer is required (measured ${facts.macos}).`);
  }
  const need = versions.diskNeedGb;
  if (facts.diskFreeGb === "not measured") problems.push(`Free disk was not measured. ${need} GB is required (${versions.goldenDiskGb} GB for the golden VM plus the desk clone).`);
  else if (Number(facts.diskFreeGb) < need) {
    problems.push(`Free ${need - Number(facts.diskFreeGb)} GB more disk. Measured ${facts.diskFreeGb} GB free; ${need} GB is required.`);
  }
  const ac = await onAcPower();
  if (ac === null) problems.push("AC power was not measured. Keep the Mac on power.");
  else if (!ac) problems.push("The Mac is not on AC power.");
  return { ok: problems.length === 0, problems, facts, needGb: need };
}
