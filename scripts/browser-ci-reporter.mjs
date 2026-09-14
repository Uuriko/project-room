// node --test reporter for the browser gates: turns every failure into a GitHub
// workflow command (an annotation on the job) and prints one duration line per
// script, so a red browser job names the script and test instead of only
// "Process completed with exit code 1". Pure output; it never changes which
// tests run or how they are judged. Used next to the spec reporter, which keeps
// the full human-readable log.
import { relative, sep } from "node:path";

const here = process.cwd();
// Workflow commands only mean something to the Actions runner; locally the same
// facts print as plain lines.
const onActions = process.env.GITHUB_ACTIONS === "true";
const scriptOf = file => (file ? relative(here, file).split(sep).join("/") : "(unknown file)");
const escapeData = text => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = text => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
const seconds = ms => (ms / 1000).toFixed(1) + "s";
const summarize = error => {
  const cause = error?.cause ?? error;
  const text = cause?.message ?? (typeof cause === "string" ? cause : String(cause));
  return text.split("\n").slice(0, 12).join("\n");
};

export default async function* browserCiReporter(source) {
  const scripts = new Map(); // script -> { duration, passed, failed, failures: [] }
  const record = (file, outcome, duration) => {
    const script = scriptOf(file), entry = scripts.get(script) ?? { duration: 0, passed: 0, failed: 0, failures: [] };
    entry[outcome] += 1; entry.duration += duration ?? 0; scripts.set(script, entry); return entry;
  };
  for await (const event of source) {
    const { type, data } = event;
    if (type === "test:pass" && data.nesting === 0) record(data.file, "passed", data.details?.duration_ms);
    if (type === "test:fail" && data.nesting === 0) {
      const entry = record(data.file, "failed", data.details?.duration_ms);
      const script = scriptOf(data.file), message = summarize(data.details?.error);
      entry.failures.push(`${data.name}: ${message.split("\n")[0]}`);
      const headline = `${script} › ${data.name} (${seconds(data.details?.duration_ms ?? 0)})`;
      yield onActions
        ? `::error file=${escapeProperty(script)},title=${escapeProperty(`browser check failed: ${data.name}`)}::${escapeData(`${headline}\n${message}`)}\n`
        : `FAIL ${headline}\n  ${message.split("\n").join("\n  ")}\n`;
    }
  }
  const rows = [...scripts.entries()].sort((a, b) => b[1].duration - a[1].duration);
  const total = rows.reduce((sum, [, entry]) => sum + entry.duration, 0);
  const failed = rows.filter(([, entry]) => entry.failed > 0);
  yield `\n${onActions ? "::group::" : "== "}Browser gate durations (${rows.length} scripts, ${seconds(total)} total, ${failed.length} failing)\n`;
  for (const [script, entry] of rows) {
    yield `${entry.failed ? "FAIL" : "ok  "} ${seconds(entry.duration).padStart(7)}  ${script}  (${entry.passed} passed, ${entry.failed} failed)\n`;
  }
  if (onActions) yield "::endgroup::\n";
  if (failed.length) {
    yield `\nFailing browser scripts: ${failed.map(([script]) => script).join(", ")}\n`;
    for (const [script, entry] of failed) for (const failure of entry.failures) yield `  ${script}: ${failure}\n`;
  }
}
