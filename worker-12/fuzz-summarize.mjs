// Summarizes worker-12/fuzz-results.json into console + SHARD12-FINDINGS.md
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(here, "fuzz-results.json"), "utf8"));
const byRoute = {};
for (const r of rows) (byRoute[r.route] ??= []).push(r);
let md = "# WORKER-12 fuzz results (shard: ROUTES rows 11/61/111)\n\n";
md += `Probes: ${rows.length}. Run: ${new Date().toISOString()}\n\n`;
const findings = [];
const hardFlag = r => {
  if (r.status === -1) return "HANG/TRANSPORT-FAIL";
  if (r.status >= 500 && !r.bodyHead.includes("gmail_not_configured")) return "5XX";
  return "";
};
for (const [route, rs] of Object.entries(byRoute)) {
  md += `## ${route} (${rs.length} probes)\n\n`;
  md += "| vector | method | status | ms | body head | flag |\n|---|---|---|---|---|---|\n";
  for (const r of rs) {
    const flag = hardFlag(r) || (r.flag === "SETUP" ? "SETUP" : "");
    md += `| ${r.vector} | ${r.method} | ${r.status} | ${r.ms} | ${r.bodyHead.replaceAll("|", "\\|").replaceAll("\n", " ")} | ${flag} |\n`;
    if (flag && !["LENGTH-MISMATCH", "BODY-MISMATCH"].includes(flag)) findings.push(`${route}: ${r.vector} -> ${flag} (status ${r.status})`);
  }
  md += "\n";
}
md += "## Flags needing follow-up\n\n" + (findings.length ? findings.map(f => `- ${f}`).join("\n") : "none") + "\n";
writeFileSync(join(here, "SHARD12-FINDINGS.md"), md);
console.log(md.slice(0, 12000));
console.log(`\n... wrote SHARD12-FINDINGS.md, ${rows.length} probes, ${findings.length} hard flags`);
