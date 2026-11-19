// Exact command verbs an owner may approve in a Mac receiver policy.
export const MAC_CHECK_KINDS = Object.freeze({
  affected: "desktop_affected_tests",
  build: "desktop_local_build",
  "native-smoke": "desktop_native_smoke"
});

export function validMacChecks(checks) {
  return Array.isArray(checks) && checks.length > 0 && checks.length <= Object.keys(MAC_CHECK_KINDS).length
    && new Set(checks).size === checks.length && checks.every(check => typeof check === "string" && Object.hasOwn(MAC_CHECK_KINDS, check));
}
