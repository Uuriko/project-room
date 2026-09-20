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
- **Dependencies:** Node.js and npm/pnpm dependencies retain their own licenses.
  Root and nested manifests/lockfiles identify exact packages. The Node service
  currently has no npm runtime dependencies; development and Workers build tools
  do. Redistributing a bundled runtime requires preserving its notices too.

For a new dependency or imported asset, include its origin, version, license and
required notices in the same PR. Do not copy competitor code or assets without
permission merely because they can be viewed online. Report attribution mistakes
through a repository issue without republishing confidential material.
