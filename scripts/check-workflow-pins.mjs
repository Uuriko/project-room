// Pinned-ref gate for workflow and local-action files (.github/workflows/**,
// .github/actions/**). A `uses:` ref must be a full 40-char commit SHA, and a
// docker:// image must carry a sha256 digest. Job `container:` and
// `services:` images are bare Docker references, so they never appear as
// docker:// — they are collected from those subtrees and must likewise carry
// a @sha256: digest; a mutable tag there re-opens the re-pointable-ref hole
// this gate exists to close. Local `./path` refs are exempt.
// It parses the YAML (not grep), so a value on the next line, a flow-style
// mapping, or a quoted ref cannot slip past. Used by .github/workflows/pin-gate.yml
// and scripts/check.mjs.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, isMap, isSeq, isScalar } from "yaml";

const SHA_REF = /^[^@\s]+@[0-9a-f]{40}$/;
const DOCKER_DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

export function refProblem(ref) {
  if (typeof ref !== "string" || !ref.trim()) return "uses is not a non-empty string";
  if (ref.startsWith("./")) return null;
  if (ref.startsWith("docker://")) return DOCKER_DIGEST.test(ref) ? null : "docker image is not pinned to @sha256:<64 hex>";
  return SHA_REF.test(ref) ? null : "ref is not pinned to a full 40-char commit SHA";
}

export function imageProblem(ref) {
  if (typeof ref !== "string" || !ref.trim()) return "image is not a non-empty string";
  if (ref.startsWith("docker://")) return DOCKER_DIGEST.test(ref) ? null : "docker image is not pinned to @sha256:<64 hex>";
  return IMAGE_DIGEST.test(ref) ? null : "image is not pinned to @sha256:<64 hex>";
}

// Every `uses` value, every docker:// `image:` value wherever it sits, and
// every bare `image:` value (plus a scalar `container:` value itself) inside
// a `container:`/`services:` subtree, so a new nesting level cannot hide one.
export function collectEntries(source) {
  const doc = parseDocument(source);
  if (doc.errors.length) throw new Error(`YAML parse error: ${doc.errors[0].message}`);
  const entries = [];
  const walk = (node, inImageScope) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? pair.key.value : null;
        if (key === "uses")
          entries.push({ kind: "uses", ref: isScalar(pair.value) ? pair.value.value : null });
        else if (key === "container" && isScalar(pair.value))
          entries.push({ kind: "image", ref: pair.value.value });
        else if (key === "image" && isScalar(pair.value)
          && (inImageScope || String(pair.value.value).startsWith("docker://")))
          entries.push({ kind: "image", ref: pair.value.value });
        walk(pair.value, inImageScope || key === "container" || key === "services");
      }
    } else if (isSeq(node)) node.items.forEach(item => walk(item, inImageScope));
  };
  walk(doc.contents, false);
  return entries;
}

export function collectRefs(source) {
  return collectEntries(source).map(entry => entry.ref);
}

export function checkSource(source) {
  return collectEntries(source).flatMap(({ kind, ref }) => {
    const problem = kind === "image" ? imageProblem(ref) : refProblem(ref);
    return problem ? [{ ref, problem }] : [];
  });
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
    console.error("FAIL: every uses: ref under .github/workflows and .github/actions must be a full commit SHA (docker:// refs and container:/services: images need @sha256:).");
    process.exit(1);
  }
  console.log("check-workflow-pins: all refs pinned");
}
