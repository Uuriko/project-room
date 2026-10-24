// Orphans C1/C4 via the ORIGINAL lane repros, vendored unmodified except
// the tree-root token. C1: HUNT-ORPHANS repro-directory-count.mjs.
// C4: ORPHANS-FIX's executed refutation repro (repro-c4.mjs).
import { vendorRun, fixed, still, notfiled } from "../lib.mjs";

const id = process.argv[2];
if (id === "ORPH-C1") {
  const { code, out, err } = await vendorRun("orphans-c1-repro.mjs.txt");
  if (out.includes("PROVEN:")) still(`directoryCounts counts receipts every other public surface hides — the original repro's verdict line: ${out.match(/PROVEN:.*/)?.[0].slice(0, 260)}`);
  else if (out.includes("NOT REPRODUCED")) {
    const m = out.match(/public_directory_entries:\s*(\{[^}]*\})/);
    fixed(`the original repro no longer proves the leak: directory entry after sync = ${m?.[1] ?? "?"} vs the stranger listing's 1 visible receipt — counts now respect takedown/opt-out`);
  } else notfiled(`orphans C1 repro exited ${code} without its verdict line: ${(err || out).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300)}`);
} else if (id === "ORPH-C4") {
  const { code, out, err } = await vendorRun("orphans-c4-repro.mjs.txt");
  if (out.includes("VERDICT: REPRODUCED")) still("the divergent import's omitted (ghost) message IS served by an archived reader at some read point — C4 reproduces after all");
  else if (out.includes("VERDICT: NOT REPRODUCED")) notfiled("refuted as filed, confirmed by ORPHANS-FIX's executed repro and re-confirmed here: ghost rows exist in events after a divergent import but are never served — readers gate on the current projection's archive marker, which import replaces. No defect to regress; the row stays in the pack so a future reader change re-opens it.");
  else notfiled(`orphans C4 repro exited ${code} without its verdict line: ${(err || out).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300)}`);
} else {
  notfiled(`orphans-vendor.mjs has no probe for ${id}`);
}
