// Resolve the executable for a native host, without hardcoding anyone's home
// directory. The runner used to name one developer's install path directly,
// which meant the acceptance exercise could only ever run on that one laptop
// and failed on every other machine with a bare ENOENT from spawn.
//
// Resolution order, first hit wins:
//   1. An explicit environment override, so an unusual install is always
//      reachable without editing the script.
//   2. The executable on PATH, which is where a normal install puts it.
//   3. A platform default, kept only for the packaged macOS application that
//      genuinely does live at a fixed location and is not on PATH.
//
// This never throws. Resolution happens before a host is started but the
// caller reserves its evidence file first, so an unresolvable binary has to
// be reportable rather than fatal; returning a reason keeps that ordering
// intact and still gives the operator something better than ENOENT.

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export const HOST_BINARY_ENV = Object.freeze({
  codex: "ROOM_NATIVE_CODEX_BIN",
  claude: "ROOM_NATIVE_CLAUDE_BIN"
});

// Only the packaged macOS app keeps a fixed default. There is deliberately no
// default for claude: a personal install path is exactly the thing this module
// exists to stop, so an absent claude resolves to a reason, not a guess.
export const HOST_BINARY_DEFAULT = Object.freeze({
  codex: "/Applications/ChatGPT.app/Contents/Resources/codex",
  claude: null
});

const executable = candidate => {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch { return false; }
};

// Walk PATH the way a shell would. Returns null rather than throwing on a
// malformed or absent PATH, because an unresolved host is a reportable
// condition and never a crash.
export const onPath = (name, pathValue) => {
  if (typeof name !== "string" || !name || name.includes("/")) return null;
  if (typeof pathValue !== "string" || !pathValue) return null;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    if (executable(candidate)) return candidate;
  }
  return null;
};

// Resolve one host to an executable path.
//   { binary }          resolved, with `source` naming which rule matched
//   { binary: null, reason } unresolved, with operator-readable guidance
export function resolveHostBinary(host, environment = process.env) {
  if (!Object.hasOwn(HOST_BINARY_ENV, host)) {
    return { binary: null, reason: `Unknown native host "${host}"` };
  }
  const variable = HOST_BINARY_ENV[host];
  const override = environment[variable];
  if (typeof override === "string" && override.trim()) {
    const candidate = override.trim();
    if (!isAbsolute(candidate)) {
      return { binary: null, reason: `${variable} must be an absolute path, got "${candidate}"` };
    }
    if (!executable(candidate)) {
      return { binary: null, reason: `${variable} points at "${candidate}", which is not an executable file` };
    }
    return { binary: candidate, source: "environment" };
  }
  const found = onPath(host, environment.PATH);
  if (found) return { binary: found, source: "path" };
  const fallback = HOST_BINARY_DEFAULT[host];
  if (fallback && executable(fallback)) return { binary: fallback, source: "default" };
  return {
    binary: null,
    reason: `Native host "${host}" is not installed on this machine: no ${variable}, nothing named "${host}" on PATH${fallback ? `, and no executable at ${fallback}` : ""}. Set ${variable} to its absolute path.`
  };
}
