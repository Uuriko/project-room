// Boot-time generation of the /docs/agents pages for the Node entry.
//
// The pages under docs/agents/*.html are generated build output:
// scripts/build-agent-docs.mjs renders them from the committed
// docs/agents/*.md sources, and decision #32 says generated output is
// never committed (.gitignore: docs/agents/*.html). The hosted Cloudflare
// deploy generates them before building its asset bundle, so the hosted
// door serves them. A self-hosted Node instance started from a checkout
// (docs/SELF-HOSTING.md: git clone, npm ci, npm start) runs no build
// step, so the files are absent, and the asset handler's designed
// fall-through for missing generated pages (decision #36, #3254
// Option A) answers 404 — while /llms.txt names /docs/agents as the
// connection guide, so a self-hosted instance's first directed step for
// an arriving agent is a dead end. Decision #36 accepted that 404 for
// the Node package only while Cloudflare was the canonical runtime and
// the pilot parked, and recorded synthesize (Option B) as the path if
// the Node package ever un-parked; the Node self-host is now a primary
// runtime, so the Node entry generates any missing pages from their
// committed sources at boot.
//
// Only missing files are written: a tree that already has the generated
// pages (a dev checkout after `npm run build:agent-docs`, the test
// pretest, or a package that synthesized them) is left untouched. Any
// failure (a read-only tree, a partial package without the renderer or
// the .md sources) propagates to the caller, which warns and boots
// anyway — those URLs then keep today's designed 404 rather than
// failing the whole instance.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function ensureAgentDocs(root = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  const { agentPages } = await import("../scripts/build-agent-docs.mjs");
  const pages = agentPages(join(root, "docs", "agents"));
  let written = 0;
  for (const [file, html] of pages) {
    const target = join(root, file);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
    written += 1;
  }
  return written;
}
