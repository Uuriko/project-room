// Release receipt metadata. These placeholder values mean "unstamped": a
// development or unbundled run. The deploy process stamps immutable revision
// and build identity at bundle time by running `node scripts/stamp-version.mjs`
// immediately before upload; do not edit the stamped values by hand.
export const SOURCE_REVISION = "unstamped";
export const BUILD_ID = "unstamped";

// Deploy-aware card fields (#650 item 4): the live stamped values above,
// never a hardcoded or docs value. An unstamped run cannot prove a revision,
// so it reports "dev" — the same rule server/agent-discovery.mjs
// deployedInfo() applies to the well-known card's deployed{} block.
// scripts/stamp-version.mjs rewrites only the two const lines above, so
// this helper survives stamping.
export function deployFields() {
  const dev = SOURCE_REVISION === "unstamped" || BUILD_ID === "unstamped";
  return {
    sourceRevision: dev ? "dev" : SOURCE_REVISION,
    buildId: dev ? "dev" : BUILD_ID,
  };
}
