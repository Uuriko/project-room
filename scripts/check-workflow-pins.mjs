// Pinned-ref gate for workflow and local-action files (.github/workflows/**,
// .github/actions/**). A `uses:` ref must be a full 40-char commit SHA, and a
// docker:// image must carry a sha256 digest. Local `./path` refs are exempt.
// It parses the YAML (not grep), so a value on the next line, a flow-style
// mapping, or a quoted ref cannot slip past. Used by .github/workflows/pin-gate.yml
// and scripts/check.mjs.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, isMap, isSeq, isScalar } from "yaml";

const SHA_REF = /^[^@\s]+@[0-9a-f]{40}$/;
const DOCKER_DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

export function refProblem(ref) {
  if (typeof ref !== "string" || !ref.trim()) return "uses is not a non-empty string";
  if (ref.startsWith("./")) return null;
  if (ref.startsWith("docker://")) return DOCKER_DIGEST.test(ref) ? null : "docker image is not pinned to @sha256:<64 hex>";
  return SHA_REF.test(ref) ? null : "ref is not pinned to a full 40-char commit SHA";
}

// Every value under a `uses` key and every `image: docker://...` in the
// document, wherever it sits, so a new nesting level cannot hide one.
export function collectRefs(source) {
  const doc = parseDocument(source);
  if (doc.errors.length) throw new Error(`YAML parse error: ${doc.errors[0].message}`);
  const refs = [];
  const walk = node => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? pair.key.value : null;
        if (key === "uses" || (key === "image" && isScalar(pair.value) && String(pair.value.value).startsWith("docker://")))
          refs.push(isScalar(pair.value) ? pair.value.value : null);
        walk(pair.value);
      }
    } else if (isSeq(node)) node.items.forEach(walk);
  };
  walk(doc.contents);
  return refs;
}

export function checkSource(source) {
  return collectRefs(source).flatMap(ref => { const problem = refProblem(ref); return problem ? [{ ref, problem }] : []; });
}

function yamlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(name) ? [path] : [];
  });
}

export function checkRepo(root = ".") {
  const failures = [];
  for (const file of [...yamlFiles(join(root, ".github/workflows")), ...yamlFiles(join(root, ".github/actions"))]) {
    try {
      for (const { ref, problem } of checkSource(readFileSync(file, "utf8"))) failures.push(`${file}: ${JSON.stringify(ref)} - ${problem}`);
    } catch (error) { failures.push(`${file}: ${error.message}`); }
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkRepo();
  if (failures.length) {
    for (const line of failures) console.error(`UNPINNED: ${line}`);
    console.error("FAIL: every uses: ref under .github/workflows and .github/actions must be a full commit SHA (docker:// refs need @sha256:).");
    process.exit(1);
  }
  console.log("check-workflow-pins: all refs pinned");
}
