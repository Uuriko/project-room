// CI gate: JSDoc type checking (tsc --checkJs) over the kernel modules
// listed in tsconfig.kernel.json — src/events.js, server/store.mjs and
// server/messages-store.mjs — and nothing else. Imported modules join the
// program for inference, but only diagnostics reported in the gated files
// fail this stage; the rest of the tree is not type-checked by this gate.
//
// `--skip-if-missing` (used by scripts/check.mjs) lets a checkout that never
// ran `npm ci` finish the rest of `npm run check` with a visible notice
// instead of failing, mirroring scripts/lint.mjs.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const skipIfMissing = args.includes("--skip-if-missing");
const tsPath = join(root, "node_modules", "typescript", "lib", "typescript.js");
if (!existsSync(tsPath)) {
  if (skipIfMissing) { console.warn("kernel-types gate skipped: typescript is not installed (run `npm ci`)"); process.exit(0); }
  console.error("Kernel-types gate: typescript is not installed. Run `npm ci` first.");
  process.exit(1);
}
const ts = (await import(tsPath)).default;

const configPath = join(root, "tsconfig.kernel.json");
const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
if (error) { console.error(ts.flattenDiagnosticMessageText(error.messageText, "\n")); process.exit(1); }
const gated = new Set((config.files ?? []).map(f => resolve(root, f)));
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);

const host = {
  getCanonicalFileName: f => f,
  getCurrentDirectory: () => root,
  getNewLine: () => "\n"
};
let failures = 0, ignored = 0;
for (const diagnostic of diagnostics) {
  const fileName = diagnostic.file ? resolve(diagnostic.file.fileName) : null;
  if (fileName === null || gated.has(fileName)) {
    failures++;
    console.error(ts.formatDiagnostic(diagnostic, host).trimEnd());
  } else {
    ignored++;
  }
}
if (failures > 0) {
  console.error(`kernel-types: ${failures} error(s) in the kernel files (${[...gated].map(f => f.slice(root.length)).join(", ")}); ${ignored} diagnostic(s) in imported files are not gated`);
  process.exit(1);
}
console.log(`kernel-types: kernel files clean (${ignored} diagnostic(s) in imported files are not gated)`);
