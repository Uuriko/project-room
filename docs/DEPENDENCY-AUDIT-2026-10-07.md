# Dependency-vulnerability audit — project-room — 2026-10-07

Scope: the project-room repo (task 163, Project Room part). dasha-settlement
and the compute kit are Dasha-side and out of scope for this lane.

## Method

- `npm audit` on the root tree and `relay/`.
- OSV.dev queries for `cloudflare/` devDeps (pnpm-only tree; pnpm not
  installed on this machine, so audited via OSV instead).
- Pinning review of all three `package.json` files.

## Findings

**Zero HIGH/CRITICAL vulnerabilities.** No remediation PR is needed; the
per-finding waiver below is vacuous (there are no findings to waive).

| Tree | Dependencies | Audit result |
|---|---|---|
| Root | **No production dependencies at all** — the server runs on Node built-ins (`node:sqlite`, `node:crypto`, …). Dev-only: eslint, playwright, fast-check, sanitize-html, yaml, pixelmatch, pngjs, globals, @axe-core/playwright, eslint-plugin-security, minimatch | `npm audit`: 0 vulnerabilities |
| `cloudflare/` | Dev-only: miniflare 4.20260730.0, esbuild 0.28.2, wrangler 4.116.0 (all exact-pinned) | OSV: 0 vulns each |
| `relay/` | Dev-only: @modelcontextprotocol/sdk ^1.31.0, esbuild 0.28.2, miniflare 4.20260730.0, wrangler 4.116.0 | `npm audit`: clean; OSV on the MCP SDK: 0 vulns |

## Pinning

Mostly exact pins. Six root devDeps use `^` ranges
(@axe-core/playwright, eslint-plugin-security, pixelmatch, pngjs, yaml,
minimatch). Waiver: dev-only tooling, CI installs from the lockfile, and
`npm audit` reports no vulnerabilities in the resolved tree — no action.

## Unmaintained packages

None identified in this small surface. The notable supply-chain fact is
structural: with zero production dependencies, the room's runtime
supply-chain attack surface is the Node.js runtime itself (>=24.19.0 per
`engines`), not the npm registry.

## Recommendation

Re-run this audit quarterly (or add `npm audit` to CI as a non-blocking
advisory job — the zero-dependency runtime makes it cheap). Next due
2027-01-07.
