# Build scripts

_Guild-10 doc-coverage page (wave1000). Generated 2026-10-09 from module header comments,
export lists, and `git grep` caller evidence. Each module below had no dedicated doc page.
Purpose/invariants/gotchas are quoted from the module's own header comment where present._

## `scripts/build-agent-docs.mjs`  (195 lines)

**Purpose.** Build the static /docs/agents pages from docs/agents/*.md and the connect table.

**Exports:** `agentPages`, `codeBlock`, `renderMarkdown`, `writeAgentPages`

**Callers/importers (git grep HEAD):** `package.json`, `tests/connect-snippets.test.js`, `tests/qa5-docs-code-a11y.test.js`

## `scripts/build-gmail-sanitizer.mjs`  (23 lines)

**Purpose.** Rebuild the self-contained sanitizer so offline runtime packages still boot. Dependency versions are pinned by package-lock.json; esbuild by cloudflare/. 2026-09-30 (phase-2 gap audit L-P2-21): resolve esbuild through Node's module resolution anchored at cloudflare/package.json instead of a hardcoded ../cloudflare/node_modules/esbuild path — the hardcoded path assumes npm's flat node_modules layout and breaks under pnpm's symlinked layout.

**Exports:** `default `

**Callers/importers (git grep HEAD):** `scripts/build-gmail-sanitizer.mjs`, `scripts/secret-scan-check.mjs`, `server/vendor/gmail-html-sanitizer.mjs`

## `scripts/build-og-atlas.mjs`  (168 lines)

**Purpose.** Builds the runtime OG assets: og/base-receipt.png, the Inter glyph atlases, and og/atlas.json. Playwright (a dev dependency) rasterizes Inter Regular from og/fonts. Re-run with `npm run build:og-atlas` after a font change. The marketing images in og/{home,about,offers,compare,receipts}.png are not written by this script.

**Callers/importers (git grep HEAD):** `eslint.config.mjs`, `package.json`

## `scripts/build-pwa-icons.mjs`  (48 lines)

**Purpose.** Rasterize favicon.svg into the PWA icon set (HB-3a). Playwright screenshots a page that draws the SVG, so the committed PNGs match the mark. Maskable icons keep the mark inside the center 80% safe zone.

## `scripts/build-ui-strings.mjs`  (7 lines)

_No header comment — purpose inferred from exports below._

**CLI:** runnable directly (`runnable as CLI`).

**Callers/importers (git grep HEAD):** `package.json`, `scripts/build-ui-strings.mjs`, `scripts/check.mjs`, `scripts/runtime-package.mjs`, `strings/en.js`
