// Merge train risk rules. A PR is "person" (needs a person) when any touched
// path matches a person rule; otherwise it is "safe" and lands without
// review. Rules are glob-lite: "**" any depth, "*" one segment part.
// Edit this list, not the classifier.
export const MERGE_TRAIN_PATH_RULES = Object.freeze({
  person: Object.freeze([
    { reason: "auth", globs: ["**/*auth*", "**/*signin*", "**/*sign-in*", "**/*oauth*", "**/*passkey*", "**/*session*", "**/*identity*", "**/*login*"] },
    { reason: "billing", globs: ["**/*billing*", "**/*payment*", "**/*stripe*", "**/*escrow*", "**/*spend*", "**/*fee-*", "**/*bounty*"] },
    { reason: "deletion", globs: ["**/*delet*", "**/*purge*", "**/*retention*", "**/*backup*"] },
    { reason: "migration", globs: ["**/migrations/**", "**/*migrat*", "**/*schema*", "server/store.mjs", "server/writer-fence.mjs"] },
    { reason: "secrets_config", globs: [".github/**", "**/wrangler*", "**/*.toml", "**/*secret*", "**/*.env*", "package.json", "package-lock.json", "cloudflare/**", "deploy/**", "server/merge-train-paths.mjs"] }
  ]),
  // Informational: paths known safe. Anything not matched by a person rule
  // is safe as well; this list only labels the reason.
  safe: Object.freeze([
    { reason: "tests", globs: ["tests/**", "**/*.test.*", "evals/**", "bench/**"] },
    { reason: "docs", globs: ["docs/**", "**/*.md", "research/**"] },
    { reason: "copy", globs: ["strings/**", "src/*copy*"] },
    { reason: "ui", globs: ["src/**/*.css", "src/*-ui.js", "**/*.html", "icons/**", "og/**"] }
  ])
});
