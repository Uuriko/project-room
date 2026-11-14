// Fails when plugins/project-room/skills/ is not an exact copy of skills/,
// or when the .agents/skills/ repo-development home (W-39 ruling, see
// scripts/skills-sync.mjs) violates its structural governance.
// Repair with: node scripts/skills-sync.mjs
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { agentsSkillDrift, skillDrift } from "./skills-sync.mjs";

export function reportSkillDrift() {
  const failures = [...skillDrift(), ...agentsSkillDrift()];
  if (failures.length === 0) {
    console.log("skills-sync-check: OK");
    return 0;
  }
  for (const failure of failures) console.error(`skills-sync-check: ${failure}`);
  console.error(`skills-sync-check: FAILED (${failures.length}). Run: node scripts/skills-sync.mjs`);
  return 1;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(reportSkillDrift());
