// Node version gate for the invite/connect entry path. The floor is the
// package's declared engines range (room-acp/package.json: >=24.19.0).
// The comparison mirrors cli/commands/doctor.mjs `nodeSatisfies` exactly —
// same parse, same ordering — duplicated only because room-acp ships as a
// standalone package whose sources cannot import the repo CLI.
export const MIN_NODE_VERSION = "24.19.0";

export function nodeSatisfies(version, minimum = MIN_NODE_VERSION) {
  const parse = value => String(value).replace(/^v/, "").split(".").map(part => Number(part));
  const [major, minor, patch] = parse(version);
  const [needMajor, needMinor, needPatch] = parse(minimum);
  if (major !== needMajor) return major > needMajor;
  if (minor !== needMinor) return minor > needMinor;
  return patch >= needPatch;
}

export function unsupportedNodeMessage(version) {
  return `room-acp needs Node.js ${MIN_NODE_VERSION} or newer (this is ${version}). Install Node.js 24.19 or newer from https://nodejs.org or with a version manager (for example: nvm install 24), then retry the same invitation — your invitation has not been used.`;
}
