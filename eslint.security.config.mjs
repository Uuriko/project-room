// Zero-bug gate: SAST pass with eslint-plugin-security.
// Run: npx eslint --config eslint.security.config.mjs .   (via npm run sast
// in CI). Every rule below is "error": any hit fails the workflow.
//
// RULESET CHOICE (documented per the zero-bug workstream brief): the full
// plugin set is too noisy to block on. Measured 2026-10-05 on this repo:
//   - detect-object-injection ....... 2022 hits, nearly all false positives
//   - detect-non-literal-fs-filename . 1122 hits (paths-by-construction are the norm here)
//   - detect-non-literal-regexp .....  139 hits (real ReDoS class, but bulk remediation, not day-one blocking)
//   - detect-unsafe-regex ...........   55 hits (same: tracked for later, not blocking now)
//   - detect-non-literal-require ....   39 hits (mostly tests)
//   - detect-possible-timing-attacks .   20 hits, all `x === true` comparisons against non-secret values
// The rules kept below were all ZERO-noise on the current tree, so they
// block PRs with no false-positive burden. Excluded rules stay candidates
// for a future "warn + ticket" lane once the pre-existing hits are triaged.
import security from "eslint-plugin-security";
import globals from "globals";

const securityErrorRules = {
  "security/detect-eval-with-expression": "error", // code injection via eval()
  "security/detect-child-process": "error", // unsanitized command execution
  "security/detect-pseudoRandomBytes": "error", // Math.random() for crypto material
  "security/detect-buffer-noassert": "error", // unsafe Buffer reads without bounds checks
  "security/detect-new-buffer": "error", // deprecated, uninitialized `new Buffer()`
  "security/detect-disable-mustache-escape": "error", // template XSS
  "security/detect-no-csrf-before-method-override": "error", // CSRF via method override
  "security/detect-bidi-characters": "error", // trojan-source unicode attacks
};

const languageOptions = { ecmaVersion: "latest", sourceType: "module" };

export default [
  { ignores: ["server/vendor/", "node_modules/", "**/node_modules/", "cloudflare/dist/", "test-results/", "coverage/", ".data/", ".tmp/"] },
  {
    files: ["server.mjs", "bin/**/*.mjs", "cli/**/*.mjs", "server/**/*.mjs", "client/**/*.mjs", "scripts/**/*.{js,mjs}", "tests/**/*.{js,mjs}", "cloudflare/**/*.mjs", "deploy/**/*.mjs", "relay/**/*.mjs", "src/**/*.js", "*/src/**/*.js", "*/tests/**/*.js"],
    plugins: { security },
    languageOptions: {
      ...languageOptions,
      globals: {
        ...globals.node,
        ...globals.browser, // browser-check scripts evaluate callbacks inside the page
        WebSocket: "readonly",
        WebSocketPair: "readonly",
        WebSocketRequestResponsePair: "readonly",
      },
    },
    rules: securityErrorRules,
  },
  {
    // tests/telegram-property.test.js intentionally embeds an RTL mark (U+200F)
    // in its property-test unicode alphabet to exercise unicode handling.
    // That is test data, not a trojan-source attack: exempt the file.
    files: ["tests/telegram-property.test.js"],
    rules: { "security/detect-bidi-characters": "off" },
  },
];
