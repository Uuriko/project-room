// announce-contract-change.mjs — FIX-43
//
// Board-ready announcements for API contract drift (COLLIDE-4 rec. 5).
// Concurrent lanes watch the room claim board for work; contract changes
// buried in a PR diff do not reach them. This helper turns an old->new
// field mapping (or two openapi.yaml revisions) into a board-ready payload
// and message text: changed fields, old type/shape -> new type/shape,
// affected routes, and a migration note.
//
// CONVENTION, not a gate: any PR that changes contract fields in
// docs/openapi.yaml runs this script before opening the PR and pastes the
// output onto the room claim board via the worker's usual post path
// (same message.posted command shape as ~/workspace/jill-plugin/post-room.mjs).
// There is deliberately no CI gate — John's culture is advisory.
//
// Usage:
//   node scripts/announce-contract-change.mjs --old docs/openapi.yaml --new docs/openapi.yaml --pr 2342
//   node scripts/announce-contract-change.mjs --old a.yaml --new b.yaml --pr 2342 --json
//   node scripts/announce-contract-change.mjs --mapping old.json --new-mapping new.json --pr 2342
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Shape pruning: keep only the contract-relevant bits of a schema node.
// ---------------------------------------------------------------------------
const SHAPE_KEYS = [
  "type", "format", "enum", "const", "maxLength", "minLength",
  "maximum", "minimum", "pattern", "required", "nullable", "default",
];

function pruneShape(node) {
  if (node == null || typeof node !== "object") return node;
  const out = {};
  for (const k of SHAPE_KEYS) {
    if (k in node && node[k] !== undefined) out[k] = node[k];
  }
  // one level of object nesting: keep child types as a compact map
  if (node.type === "object" && node.properties && typeof node.properties === "object") {
    out.properties = {};
    for (const [pk, pv] of Object.entries(node.properties)) {
      out.properties[pk] = typeof pv === "object" && pv !== null ? pv.type ?? "?" : pv;
    }
  }
  if (node.type === "array" && node.items && typeof node.items === "object") {
    out.items = { type: node.items.type ?? "?" };
  }
  return out;
}

function shapeEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Field-key helpers. Keys look like:
//   "POST /api/things -> request.body.size"
//   "GET /api/things -> response.200.id"
// The route is everything before " -> ".
// ---------------------------------------------------------------------------
function routeOf(fieldKey) {
  const i = fieldKey.indexOf(" -> ");
  return i >= 0 ? fieldKey.slice(0, i) : fieldKey;
}

// ---------------------------------------------------------------------------
// diffFieldMappings(oldMap, newMap)
// Maps are { "METHOD /path -> field.path": shape }.
// ---------------------------------------------------------------------------
export function diffFieldMappings(oldMap, newMap) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [field, newShape] of Object.entries(newMap)) {
    if (!(field in oldMap)) {
      added.push({ field, route: routeOf(field), newShape });
    } else if (!shapeEqual(oldMap[field], newShape)) {
      changed.push({ field, route: routeOf(field), oldShape: oldMap[field], newShape });
    }
  }
  for (const [field, oldShape] of Object.entries(oldMap)) {
    if (!(field in newMap)) removed.push({ field, route: routeOf(field), oldShape });
  }
  return { added, removed, changed, empty: added.length + removed.length + changed.length === 0 };
}

// ---------------------------------------------------------------------------
// OpenAPI -> field mapping: walk paths -> operations -> request/response bodies.
// ---------------------------------------------------------------------------
function flattenProps(props, prefix, out) {
  if (!props || typeof props !== "object") return;
  for (const [name, sub] of Object.entries(props)) {
    if (sub == null || typeof sub !== "object") continue;
    const path = `${prefix}.${name}`;
    out[path] = pruneShape(sub);
    if (sub.type === "object" && sub.properties) {
      flattenProps(sub.properties, path, out);
    }
  }
}

function openapiToFieldMap(doc) {
  const map = {};
  const paths = doc && doc.paths;
  if (!paths || typeof paths !== "object") return map;
  for (const [path, item] of Object.entries(paths)) {
    if (item == null || typeof item !== "object") continue;
    for (const [method, op] of Object.entries(item)) {
      if (!/^(get|put|post|delete|patch|head|options|trace)$/i.test(method)) continue;
      const route = `${method.toUpperCase()} ${path}`;
      const req = op?.requestBody?.content?.["application/json"]?.schema;
      if (req?.properties) {
        const props = {};
        flattenProps(req.properties, "", props);
        for (const [p, shape] of Object.entries(props)) {
          map[`${route} -> request.body${p}`] = shape;
        }
      }
      const responses = op?.responses;
      if (responses && typeof responses === "object") {
        for (const [status, resp] of Object.entries(responses)) {
          const schema = resp?.content?.["application/json"]?.schema;
          if (schema?.properties) {
            const props = {};
            flattenProps(schema.properties, "", props);
            for (const [p, shape] of Object.entries(props)) {
              map[`${route} -> response.${status}${p}`] = shape;
            }
          }
        }
      }
    }
  }
  return map;
}

export function diffOpenapiSpecs(oldText, newText) {
  const oldDoc = parseYaml(oldText);
  const newDoc = parseYaml(newText);
  return diffFieldMappings(openapiToFieldMap(oldDoc), openapiToFieldMap(newDoc));
}

// ---------------------------------------------------------------------------
// Migration note: best-effort severity guidance, not policy.
// ---------------------------------------------------------------------------
function severity(entry) {
  if (entry.oldShape && !entry.newShape) return "breaking"; // removed
  if (!entry.oldShape && entry.newShape) {
    // added: breaking only if required
    return entry.newShape.required === true ? "breaking" : "additive";
  }
  if (entry.oldShape?.type !== entry.newShape?.type) return "breaking";
  const oldEnum = entry.oldShape?.enum;
  const newEnum = entry.newShape?.enum;
  if (Array.isArray(oldEnum) && Array.isArray(newEnum) && newEnum.length > oldEnum.length) {
    return oldEnum.every((v) => newEnum.includes(v)) ? "additive" : "breaking";
  }
  return "changed";
}

function migrationNoteFor(diff) {
  const all = [
    ...diff.changed,
    ...diff.added.map((a) => ({ ...a, oldShape: undefined })),
    ...diff.removed.map((r) => ({ ...r, newShape: undefined })),
  ];
  const breaking = all.filter((e) => severity(e) === "breaking");
  if (breaking.length > 0) {
    return `BREAKING: ${breaking.length} change(s) require caller updates before deploy: ` +
      breaking.map((e) => e.field).join(", ");
  }
  if (all.length > 0) {
    return "Additive/non-breaking: safe for concurrent lanes to adopt at their own pace; " +
      "no caller migration required.";
  }
  return "No contract changes.";
}

function shapeOneLine(s) {
  if (s === undefined || s === null) return "—";
  const bits = [];
  if (s.type) bits.push(s.type + (s.format ? ` (${s.format})` : ""));
  if (Array.isArray(s.enum)) bits.push(`enum[${s.enum.join("|")}]`);
  if (s.maxLength !== undefined) bits.push(`maxLength=${s.maxLength}`);
  if (s.required === true) bits.push("required");
  return bits.join(" ") || JSON.stringify(s);
}

// ---------------------------------------------------------------------------
// buildAnnouncement(diff, { pr, author, at }) -> { payload, text }
// ---------------------------------------------------------------------------
export function buildAnnouncement(diff, opts = {}) {
  const { pr = null, author = null, at = new Date().toISOString() } = opts;
  const migrationNote = migrationNoteFor(diff);
  const changes = [
    ...diff.changed.map((c) => ({
      field: c.field, route: c.route,
      oldShape: c.oldShape, newShape: c.newShape, kind: "changed", severity: severity(c),
    })),
    ...diff.added.map((a) => ({
      field: a.field, route: a.route,
      oldShape: null, newShape: a.newShape, kind: "added",
      severity: severity({ ...a, oldShape: undefined }),
    })),
    ...diff.removed.map((r) => ({
      field: r.field, route: r.route,
      oldShape: r.oldShape, newShape: null, kind: "removed", severity: "breaking",
    })),
  ];
  const routes = [...new Set(changes.map((c) => c.route))].sort();
  const payload = {
    kind: "contract-change-announcement",
    fix: "FIX-43",
    pr, author, at,
    empty: diff.empty,
    routes,
    changes,
    migrationNote,
  };

  const head = diff.empty
    ? `FIX-43 contract announcement — PR #${pr ?? "?"}: no contract changes detected.`
    : `FIX-43 contract announcement — PR #${pr ?? "?"}${author ? ` (lane: ${author})` : ""}`;
  const lines = [head, ""];
  if (diff.changed.length) {
    lines.push("CHANGED FIELDS:");
    for (const c of diff.changed) {
      lines.push(`- ${c.field}`);
      lines.push(`    old: ${shapeOneLine(c.oldShape)}`);
      lines.push(`    new: ${shapeOneLine(c.newShape)}  [${severity(c)}]`);
    }
    lines.push("");
  }
  if (diff.added.length) {
    lines.push("ADDED FIELDS:");
    for (const a of diff.added) lines.push(`- ${a.field}  (${shapeOneLine(a.newShape)})`);
    lines.push("");
  }
  if (diff.removed.length) {
    lines.push("REMOVED FIELDS:");
    for (const r of diff.removed) lines.push(`- ${r.field}  (was ${shapeOneLine(r.oldShape)})  [breaking]`);
    lines.push("");
  }
  if (routes.length) lines.push(`AFFECTED ROUTES: ${routes.join(", ")}`, "");
  lines.push(`MIGRATION: ${migrationNote}`);
  if (!diff.empty) lines.push("Paste the payload as JSON alongside this text when posting to the room claim board.");
  return { payload, text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function usage() {
  console.error(
    "usage: node scripts/announce-contract-change.mjs --old <file> --new <file> [--pr N] [--author X] [--json]\n" +
    "   or: node scripts/announce-contract-change.mjs --mapping <old.json> --new-mapping <new.json> [--pr N] [--author X] [--json]\n" +
    "Prints a board-ready contract-change announcement (text default, --json for the payload).\n" +
    "Post the output to the room claim board with your usual board post path."
  );
  process.exit(2);
}

const isMain = process.argv[1] && process.argv[1].endsWith("announce-contract-change.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  if (args.includes("--help") || args.includes("-h")) usage();
  const oldFile = get("--old");
  const newFile = get("--new");
  const oldMapFile = get("--mapping");
  const newMapFile = get("--new-mapping");
  const pr = get("--pr");
  const author = get("--author");
  const asJson = args.includes("--json");

  let diff;
  if (oldFile && newFile) {
    diff = diffOpenapiSpecs(readFileSync(oldFile, "utf8"), readFileSync(newFile, "utf8"));
  } else if (oldMapFile && newMapFile) {
    diff = diffFieldMappings(
      JSON.parse(readFileSync(oldMapFile, "utf8")),
      JSON.parse(readFileSync(newMapFile, "utf8"))
    );
  } else {
    usage();
  }
  const { payload, text } = buildAnnouncement(diff, { pr: pr ? Number(pr) : null, author });
  console.log(asJson ? JSON.stringify(payload, null, 2) : text);
}
