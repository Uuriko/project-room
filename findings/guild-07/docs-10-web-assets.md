# Web assets — HTML pages, manifest, icons

**Scope note.** This slice owns the static web assets: the root HTML pages, `manifest.webmanifest`, `favicon.svg`/`icon.svg`, and `icons/`. The `public/` directory named in the slice does not exist in this tree (verified: `ls` empty). The pages' JavaScript and CSS live under `src/` — outside this slice (another guild's paths) — so this doc covers the HTML shells, their wiring, and asset hygiene, not the JS bundles.

## Pages

| Page | Size | Purpose |
|---|---|---|
| `index.html` | 94 KiB | Main room app shell. Full SEO/OG/Twitter meta, canonical `https://room.trydemigod.com/`, `llms.txt` help link, stylesheets (`styles.css`, `board.css`, `public-a11y.css`, `human-experience.css`), skip-link a11y, loads `./src/app.js` + `./src/request-access.js` as modules. |
| `join.html` | 3.8 KiB | Invite redemption. `{{ASSET_BASE}}` template placeholders for asset prefix (rewritten at serve time). Consent-first UI: room title, inviter, profile, permissions list, expiry, name form. `<noscript>` fallback explains the no-JS path and points agents at `/llms.txt`. `robots: noindex, nofollow`. Loads `join-watchdog.js` + `join.js`. |
| `about.html` | 5.2 KiB | Marketing/about page. |
| `offers.html` | 3.0 KiB | Help-offers surface. |
| `operator.html` | 5.5 KiB | Operator console. Loads `/src/operator-ui.js`. |
| `offline.html` | 498 B | Offline fallback shell. |
| `404.html` | 377 B | Minimal not-found. |

**Data flow.** Static HTML served by the room's HTTP layer; `{{ASSET_BASE}}` is substituted per deployment (join.html); all dynamic behavior comes from the `src/*.js` modules (out of slice).

**Invariants / hygiene.**
- No `innerHTML`, `document.write`, or `eval(` in any page (grep-verified) — the shells themselves contain no script sinks; XSS posture depends on the `src/*.js` bundles (other guild's slice).
- `join.html` is `noindex, nofollow` — invite links must not be crawled.
- Every page declares `utf-8` + viewport; `index.html` carries the full meta/OG set and theme-color.

**Gotchas.**
- `join.html`'s `{{ASSET_BASE}}` placeholders mean the file is a *template*, not servable as-is — a naive static serve would 404 every asset. Any verification of the join page must go through the templated serve path.
- `index.html` is 94 KiB of mostly static shell — the app boots from `src/app.js`; the shell's job is SEO/meta/a11y, not content.

## manifest.webmanifest + icons

- `manifest.webmanifest` (479 B): PWA manifest — name "Project Room", `display: standalone`, `start_url: /`, theme/background `#202127`, icons: `/favicon.svg` (any), `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/maskable-512.png` (maskable).
- `icons/`: `apple-touch-icon-180.png`, `icon-192.png`, `icon-512.png`, `maskable-512.png` — all present and referenced; no orphan or missing icon references.
- `favicon.svg` + `icon.svg` at root; `manifest` and `apple-touch-icon` links present on `index.html` and `join.html`.
