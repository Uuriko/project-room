// Dependency audit (H006). A pure dependency-manifest auditor: given a parsed
// package.json-style manifest (dependencies + devDependencies), it flags
// risky patterns — unpinned versions (*, latest, bare ranges), http://
// registry URLs, git/ssh dependencies, and file: references outside the
// project. Each finding has a severity and a risk score; the summary rolls
// up totals and an overall risk level. No network calls, no file reads —
// the caller supplies the manifest object. Pure, dependency-free,
// deterministic; frozen outputs. Registry/CVE wiring is a later slice.
const SEVERITY_WEIGHT = Object.freeze({ critical: 10, high: 5, medium: 2, low: 1 });
const RISK_LEVELS = Object.freeze([[20, "high"], [8, "medium"], [1, "low"], [0, "none"]]);
class DepAuditError extends Error { constructor(code, message) { super(message); this.name = "DepAuditError"; this.code = code; } }
const fail = (code, message) => { throw new DepAuditError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_dep_audit", message); };

const findingsFor = (name, version) => {
  check(typeof name === "string" && name.length > 0, "dependency name must be a non-empty string");
  check(typeof version === "string" && version.length > 0, `dependency "${name}" needs a version string`);
  const findings = [];
  if (/^(?:\*|latest|next)$/i.test(version.trim())) {
    findings.push({ severity: "high", rule: "unpinned", detail: `version "${version}" is not pinned` });
  } else if (/^[~^]/.test(version.trim()) && !/^\d/.test(version.replace(/^[~^]/, "").trim())) {
    findings.push({ severity: "medium", rule: "loose-range", detail: `version "${version}" allows unreviewed updates` });
  }
  if (/^https?:\/\//i.test(version) && !/^https:\/\//i.test(version)) {
    findings.push({ severity: "critical", rule: "insecure-url", detail: `dependency "${name}" fetched over plain http` });
  }
  if (/^(?:git\+|github:|gitlab:|bitbucket:|ssh:)/i.test(version)) {
    findings.push({ severity: "medium", rule: "git-dependency", detail: `dependency "${name}" pinned to a git ref, not a registry` });
  }
  if (/^file:/i.test(version)) {
    findings.push({ severity: "low", rule: "file-dependency", detail: `dependency "${name}" is a local file reference` });
  }
  return findings.map(f => Object.freeze({ name, ...f }));
};
// Audit a manifest. manifest is { dependencies?: {...}, devDependencies?: {...} }.
export function auditDependencies(manifest) {
  check(manifest !== null && typeof manifest === "object", "manifest must be an object");
  const findings = [];
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = manifest[section] ?? {};
    check(deps !== null && typeof deps === "object", `manifest.${section} must be an object`);
    for (const [name, version] of Object.entries(deps)) {
      findings.push(...findingsFor(name, version));
    }
  }
  const score = findings.reduce((total, f) => total + SEVERITY_WEIGHT[f.severity], 0);
  const level = RISK_LEVELS.find(([threshold]) => score >= threshold)[1];
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;
  return Object.freeze({ score, level, total: findings.length,
    bySeverity: Object.freeze(bySeverity), findings: Object.freeze(findings) });
}
export { DepAuditError, SEVERITY_WEIGHT };
