# Native paste prompt selection

Base fd631a69d + doc-fact correction229a860d. Focused generator baseline: one failure because no textarea existed. After: five tests pass, none skipped. Checks cover exact live Markdown prompt text/newlines, adversarial HTML escaping, readonly field and explicit label, and other documentation retaining named focusable PRE blocks. Existing HowTo and narrow-width tests remain green. ESLint and git diff check exit0.

Only paste-page fenced content receives this renderer. No JS, clipboard API, new button, CSP change or app.js change. CSS uses the existing generated docs style block. Generated HTML is built by existing deployment/package tooling, not committed. Safari real keyboard validation remains a post-deploy browser check; no clipboard-denial claim.

Captured logs have trailing whitespace normalized; assertions and outcomes are unchanged.
