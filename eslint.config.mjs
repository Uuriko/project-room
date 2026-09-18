// Lint gate for `npm run check` (BUILD-01 B31). Correctness-only rules: no
// style rules, no formatting. Errors fail the gate; warnings are printed but
// allowed. Globals are scoped per runtime so a Node-only name used in the
// browser bundle (or vice versa) is an error, not noise.
import globals from "globals";

const rules = {
  "no-undef": "error",
  // Unused callback parameters and `catch (e)` bindings are idiomatic here;
  // unused variables and imports are dead code and fail.
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true, varsIgnorePattern: "^_" }],
  "no-unreachable": "error",
  "no-dupe-keys": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  "eqeqeq": ["error", "always", { null: "ignore" }],
  // Reported, not enforced: the existing `let browser, page;` + try/finally
  // pattern in the browser checks trips it, and changing that in bulk is
  // churn for a lint PR. Promote to "error" once the warnings are gone.
  "prefer-const": ["warn", { destructuring: "all" }],
};
const languageOptions = { ecmaVersion: "latest", sourceType: "module" };

export default [
  { ignores: ["node_modules/", "**/node_modules/", "cloudflare/dist/", "test-results/", "coverage/", ".data/"] },
  // Browser bundle (index.html loads src/app.js as a module).
  { files: ["src/**/*.js"], languageOptions: { ...languageOptions, globals: { ...globals.browser } }, rules },
  // Node: server, agent client CLI, scripts, tests, Workers glue, deploy
  // helpers, and the small isolated packages.
  {
    files: ["server.mjs", "server/**/*.mjs", "client/**/*.mjs", "scripts/**/*.{js,mjs}", "tests/**/*.{js,mjs}", "cloudflare/**/*.mjs", "deploy/**/*.mjs", "*/src/**/*.js", "*/tests/**/*.js"],
    languageOptions: { ...languageOptions, globals: { ...globals.node } },
    rules,
  },
  // Playwright browser checks and manual exercises evaluate callbacks inside
  // the page (`page.evaluate(() => document...)`), and the inbox prototype
  // is itself a browser module, so those files also see browser globals.
  // Door hash-forward is authored as a Node export then stringified into the
  // public door HTML, so it legitimately references browser globals.
  {
    files: ["deploy/room-entry.mjs"],
    languageOptions: { ...languageOptions, globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["scripts/*-check.mjs", "scripts/*-exercise.mjs", "scripts/*-journey.mjs", "scripts/inbox-prototype/**/*.mjs"],
    languageOptions: { ...languageOptions, globals: { ...globals.node, ...globals.browser } },
  },
];
