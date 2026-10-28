// Release receipt metadata. These placeholder values mean "unstamped": a
// development or unbundled run. The deploy process stamps immutable revision
// and build identity at bundle time by running `node scripts/stamp-version.mjs`
// immediately before upload; do not edit the stamped values by hand.
export const SOURCE_REVISION = "unstamped";
export const BUILD_ID = "unstamped";
// package.json version. Kept here so a request can name it without reading
// package.json, which the Worker bundle does not include.
export const PACKAGE_VERSION = "0.1.0";
