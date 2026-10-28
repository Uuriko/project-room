# Browser checks in a sandbox without system libraries

**Summary.** Playwright's headless Chromium needs about ten shared libraries that slim containers do not have. `scripts/browser-userland-libs.mjs` finds the missing libraries with `ldd`, downloads the matching Debian packages, and unpacks them into a user cache directory. No root access is needed. You then run the browser checks with `LD_LIBRARY_PATH` set to that directory.

## Steps
1. Install the browser: `npx playwright install chromium-headless-shell` (no `--with-deps`, that needs root).
2. See what is missing: `node scripts/browser-userland-libs.mjs --check`.
3. Fetch and unpack the libraries: `eval "$(node scripts/browser-userland-libs.mjs)"`. The command prints one `export LD_LIBRARY_PATH=...` line.
4. Run a check: `node --test scripts/a11y-login-browser-check.mjs`, or `npm run test:browser`.

## Settings
- `BROWSER_LIBS_DIR`: cache directory. Default `~/.cache/project-room-browser-libs`.
- `BROWSER_LIBS_MIRROR`: Debian mirror. Default `https://deb.debian.org/debian`.
- `BROWSER_LIBS_SUITE`: Debian suite. Default is `VERSION_CODENAME` from `/etc/os-release`, else `trixie`.
- `BROWSER_EXE`: the browser binary to inspect. Default is the newest Playwright headless shell in `PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`.

## Limits
- Linux x64 and Debian-based images only. Other systems exit 0 with a notice.
- A library with no entry in `SONAME_TO_DEB` stops the script with its name. Add the mapping and run again.
- Fonts are not installed. Text renders with the fonts the image has, so visual-regression baselines can differ from CI.
- CI keeps `playwright install --with-deps`. This script is for agent sandboxes and dev containers.
