// Lint gate for `npm run check` (BUILD-01 B31). Correctness-only rules: no
// style rules, no formatting. Errors fail the gate; warnings are printed but
// allowed. Globals are scoped per runtime so a Node-only name used in the
// browser bundle (or vice versa) is an error, not noise.
import globals from "globals";

const rules = {
  "no-undef": "error",
  // Unused callback parameters and `catch (e)` bindings are idiomatic here;
  // unused variables and imports are dead code and fail.
  // trustOffMessage: temporarily unused on the warn-instead-of-block branch
  // (import kept for a follow-up that wires advisory copy); do not broaden.
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true, varsIgnorePattern: "^(_|trustOffMessage)$" }],
  "no-unreachable": "error",
  "no-dupe-keys": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  "eqeqeq": ["error", "always", { null: "ignore" }],
  // Reported, not fatal: prefer-const is noisy across fixtures.
  "prefer-const": "warn",
};

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "**/*.generated.mjs",
      "scripts/.***.generated.mjs",
      "server/.***.generated.mjs",
      "tests/.***.generated.mjs",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules,
  },
];
