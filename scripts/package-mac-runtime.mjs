import { parse } from "acorn";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entries = ["scripts/run-codex-room.mjs", "scripts/native-agent-setup.mjs"];
export function packageMacRuntime(source, destination) {
  const root = realpathSync(source), output = resolve(destination), files = new Map();
  if (existsSync(output)) throw new Error("Runtime destination must be new");
  function visit(path) {
    const real = realpathSync(path), name = relative(root, real);
    if (name.startsWith("..") || isAbsolute(name)) throw new Error("Runtime import escapes source");
    if (files.has(name)) return;
    const data = readFileSync(real); files.set(name, data);
    const ast = parse(data.toString(), { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type) && node.source) {
        const specifier = node.source.value;
        if (typeof specifier !== "string") throw new Error(`Dynamic runtime import in ${name}`);
        if (!specifier.startsWith("node:")) {
          if (!specifier.startsWith(".")) throw new Error(`Unpackaged runtime dependency in ${name}`);
          visit(resolve(dirname(real), specifier));
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === "object") walk(value);
      }
    }
    walk(ast);
  }
  for (const entry of entries) visit(join(root, entry));
  files.set("package.json", Buffer.from(JSON.stringify({ private: true, type: "module" }) + "\n"));
  const manifest = { version: 1, entries, files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") })) };
  mkdirSync(output, { recursive: true });
  try {
    for (const [path, data] of files) { mkdirSync(dirname(join(output, path)), { recursive: true }); writeFileSync(join(output, path), data); }
    writeFileSync(join(output, "runtime-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
  return { files: files.size, bytes: [...files.values()].reduce((sum, data) => sum + data.length, 0) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/package-mac-runtime.mjs NEW_OUTPUT_DIRECTORY");
  console.log(JSON.stringify(packageMacRuntime(fileURLToPath(new URL("../", import.meta.url)), process.argv[2])));
}
