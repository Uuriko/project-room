# Attribution and license scope

Original Project Room code and documentation are licensed under Apache-2.0.
Existing third-party notices remain effective. The root license does not
relicense dependencies, quoted source material or third-party artwork.

- **Rowboat:** scheduler/board and agent-card adaptations are identified in
  `scripts/room`, `ROOM-HEALTH.md`, and `lanes/instinct.md`. Preserve these
  notices and [NOTICE](NOTICE). Upstream:
  https://github.com/rowboatlabs/rowboat (Apache-2.0).
- **Research screenshots:** images in `research/**/screenshots/` depict other
  products for comparison. They are excluded from our Apache license; their
  associated research documents supply context and source links. Do not use
  them as Project Room product assets or imply endorsement.
- **Quotations, product names and logos:** third-party rights remain with their
  owners. Source links in research documents are attribution, not a license grant.
- **Test-audit skill:** `.agents/skills/test-audit/` is copied from [OpenClaw](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md) (`SKILL.md` and `CAMPAIGN.md`). Copyright (c) 2026 OpenClaw Foundation, MIT. The MIT text is in `.agents/skills/test-audit/LICENSE`. The "Project Room" section at the end of `SKILL.md` is a local adaptation. This does not relicense the rest of the repository.
- **Inter:** `og/fonts/Inter-Regular.ttf` is Inter 4.1 Regular by The Inter Project Authors, used only to rasterize the runtime Open Graph glyph atlas. SIL Open Font License 1.1. The license text is `og/fonts/OFL.txt`. Upstream: https://github.com/rsms/inter
- **Emoji shortcodes:** `src/emoji-catalog.js` vendors names, descriptions, and tags from [github/gemoji](https://github.com/github/gemoji) `db/emoji.json` (MIT). Modifier-base code points are from Unicode Emoji 16.0 `emoji-data.txt` (© 2024 Unicode®, Inc., [Unicode terms of use](https://www.unicode.org/terms_of_use.html)). The glyphs themselves are Unicode characters, not copied artwork.
- **Dependencies:** Node.js and npm/pnpm dependencies retain their own licenses.
  Root and nested manifests/lockfiles identify exact packages. The Node service
  currently has no npm runtime dependencies; development and Workers build tools
  do. Redistributing a bundled runtime requires preserving its notices too.
- **herdr:** the session-adapter layer (`server/session-adapter.mjs`) and any vendored
  process-home code are derived from [herdrdev/herdr](https://github.com/herdrdev/herdr)
  (Apache-2.0), forked to https://github.com/Uuriko/herdr for version pinning and
  supply-chain stripping (remote manifest catalog disabled, telemetry/phone-home removed —
  see the fork's `DEMIGOD-CHANGES.md`). Copyright (c) herdrdev (as published upstream).
  Upstream NOTICE: none shipped; the Apache-2.0 LICENSE text is preserved in the fork.
  Local changes: enumerated in the fork's `DEMIGOD-CHANGES.md` (strip lane: `demigod/strip-v1`).

For a new dependency or imported asset, include its origin, version, license and
required notices in the same PR. Do not copy competitor code or assets without
permission merely because they can be viewed online. Report attribution mistakes
through a repository issue without republishing confidential material.
