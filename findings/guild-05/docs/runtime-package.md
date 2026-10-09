# scripts/runtime-package.mjs — reference (guild-05 D6)

## Purpose
Offline exact-commit packaging. No dependency installation, upload or deployment.
This verifier is standalone: it can be copied outside the source checkout.
import { execFileSync } from "node:child_process";

## Algorithm (create)
1. Validate commit is a 40-char hash and resolves in this checkout's history (full history required).
2. ls-tree the allowlisted paths; every tree entry must be in the allowlist.
3. All required files present; cat-file blobs; compute runtimeMetadata (store schema, engines.node, wrangler config).
4. Destination must be absolute+normalized; mkdir 0700 (never reuse/overwrite); write files 0600 wx.
5. Manifest (runtime-manifest.json) written LAST as the completion marker — a partial dir is not a package.
6. Self-verify before returning.

## Algorithm (verify)
- Walk: every file must be allowlisted (or the manifest); every dir a prefix of an allowlisted path; no symlinks at root.
- Manifest: format 1, hash-shaped commit/tree, files sorted+unique, all required present, dir matches manifest exactly.
- Per file: bytes length + sha256 match; every manifest entry allowlisted.
- publicAssets recomputed from the packaged asset declaration and compared exactly.
- Literal import closure: every relative import in .mjs/.js must resolve inside the package (not a full parser — cold tests + review still required).
- runtimeMetadata recomputed and compared.

## Allowlist shape
- required: v8Assets + server.mjs + package.json + package-lock.json + server/*.mjs core + client/*.mjs + scripts/*.mjs subset + cloudflare/* (sorted).
- optional: push-appended list (diagnostics, agent-connections, public-work-*, dm-consents, bonds, ...).
- invariant: every server/*.mjs imported by server/http.mjs MUST be registered (exact allowlist) or the browser gate fails deterministically.
