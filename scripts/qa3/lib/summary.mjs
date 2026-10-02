// Job summary for the QA3 gates. expectedFail cells stay green and are listed
// in GITHUB_STEP_SUMMARY. A cell that matches while its flag is still set
// fails the run, so the flag is removed once the fix lands.
import { appendFileSync } from "node:fs";

export function assertLocalOrigin(origin) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    console.error("qa3 gates are local-only");
    process.exit(2);
  }
}

export function createReport(title) {
  const passes = [];
  const expected = [];
  const failures = [];
  const skips = [];

  return {
    pass(name) { passes.push(name); },
    skip(name, why) { skips.push({ name, why }); },
    expectFail(name, finding) { expected.push({ name, finding }); },
    fail(name, detail) { failures.push({ name, detail }); },
    cell({ name, matched, expectedFail, detail }) {
      if (matched && expectedFail) {
        failures.push({ name, detail: `expectedFail ${expectedFail} but the check passed; remove the flag. ${detail ?? ""}`.trim() });
        return;
      }
      if (!matched && expectedFail) {
        expected.push({ name, finding: expectedFail, detail });
        return;
      }
      if (!matched) failures.push({ name, detail: detail ?? "mismatch" });
      else passes.push(name);
    },
    finish() {
      const lines = [
        `### ${title}`,
        "",
        `pass ${passes.length}; expectedFail ${expected.length}; skip ${skips.length}; fail ${failures.length}`,
      ];
      if (passes.length > 0 && passes.length <= 40) {
        lines.push("", "pass:");
        for (const name of passes) lines.push(`- ${name}`);
      }
      if (expected.length) {
        lines.push("", "expectedFail:");
        for (const item of expected) lines.push(`- ${item.name} (${item.finding})${item.detail ? `: ${item.detail}` : ""}`);
      }
      if (skips.length) {
        lines.push("", "skipped:");
        for (const item of skips) lines.push(`- ${item.name}: ${item.why}`);
      }
      if (failures.length) {
        lines.push("", "fail:");
        for (const item of failures) lines.push(`- ${item.name}: ${item.detail}`);
      }
      lines.push("");
      const text = lines.join("\n");
      console.log(text);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
      return failures.length ? 1 : 0;
    },
  };
}
