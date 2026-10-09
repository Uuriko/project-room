// h-u15: SKIPPED_RECHECK_MS liveness probe. Prints the value and where it is
// consumed; no suite pins it (expected SURVIVED -> test-gap note).
import { SKIPPED_RECHECK_MS } from "/home/hatch/workspace/pr-wave1000-guild-11/server/agent-plugin-store.mjs";
console.log("SKIPPED_RECHECK_MS=" + SKIPPED_RECHECK_MS);
process.exit(0);
