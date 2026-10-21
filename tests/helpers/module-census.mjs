// BG-1 boot-graph census recorder. Loaded into a boot child process via
// `node --import <this file>`; records every file: module the process loads
// (ESM load hook) and writes the set as JSON to $MODULE_CENSUS_OUT on exit
// (and periodically, so a hard kill still leaves a recent census).
//
// The census consumer (tests/boot-graph.test.js) maps the URLs back to
// repo-relative paths and diffs two boots. This file is test tooling only:
// it is never imported by server code and never packaged.
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";

const out = process.env.MODULE_CENSUS_OUT;
if (out) {
  const loaded = new Set();
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) loaded.add(url);
      return nextLoad(url, context);
    },
  });
  const flush = () => {
    try { writeFileSync(out, JSON.stringify([...loaded])); } catch { /* census is evidence, never a boot dependency */ }
  };
  process.on("exit", flush);
  const timer = setInterval(flush, 250);
  timer.unref();
}
