# Additional genuine protocol19 fixture repair

One-test commit `a7671262819444fdf41737ae6e85ebadcf5c0ac5`, atop6e1/6c73. Runtime qualification is **composed**, not the literal committed tree: baseac0a9 server code plus exactly three temporary Root-owned restore files copied from `pr-fresh-wake-release-1103`. Their full SHA256 hashes are recorded in qualification.json. None of Root’s runtime files or source patches is included in this commit/evidence. The temporary copies were removed from this isolated worktree after testing; Root’s checkout was untouched.

Original test reproduced1failure: the genuine archived protocol19/schema45 held credentials UPDATE correctly fails missing `project_room_writer_v46`, before the restore seal trigger. The cure asserts that exact schema-floor refusal, then independently executes identical SQL on the actual current46 connection and preserves the original sealed/restore refusal. Cold old constructor now correctly asserts newer-schema refusal. Archived old source remains unmodified and never receives function46.

Warm old19 continuation still refuses422 without dropping a guard or advancing control. Its refusal is now more specific: `restore_continuation_refused`, with exact restore-admission schema reconciliation category. Existing zeroDROP counter, identical saved progress and supported current continuation202 assertions remain.

```
node --test tests/restore-result-envelope-protocol.test.mjs
node node_modules/eslint/bin/eslint.js tests/restore-result-envelope-protocol.test.mjs
```

Before0pass/1fail; after1pass/0fail/0skip. ESLint exits0 with one existing prefer-const warning; diff check0. No broader restore tests, Native, provider, credential, live, merge or deploy work. Original nine-file63green proof remains separately source-pinned without these temporary runtime overlays.
