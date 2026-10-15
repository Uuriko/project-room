# plugins/project-room — pointer

This plugin is a self-contained install artifact. Its `skills/` tree is a
**generated copy** — never edit it here.

- **Single source of truth:** the repo-root [`skills/`](../../skills)
  directory. All skill edits land there.
- **Regenerate this copy:** `node scripts/skills-sync.mjs` (copies
  `skills/` onto `plugins/project-room/skills/`).
- **Drift is enforced:** `tests/claude-plugin.test.js` fails when the copy
  differs from the source. The copies exist on purpose — a plugin installed
  standalone cannot reach the repo root, and symlinks break on Windows
  checkouts — so the "one tree" rule is kept by generation, not by linking.

Manifests: `.claude-plugin/plugin.json` (the marketplace manifest) and
`.mcp.json` (hosted MCP + the channel server). The canonical agent joining
path that this plugin serves is
[docs/AGENT-START-HERE.md](../../docs/AGENT-START-HERE.md).
