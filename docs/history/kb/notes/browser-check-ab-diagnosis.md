# Browser check failures: A/B test before trusting the first diagnosis

**Date:** 2026-09-21
**Applies to:** anyone debugging a failing project-room browser check in CI

When a project-room browser check fails in CI with a generic assertion
message, don't trust the first-line diagnosis. Use an A/B test: stash
the suspected fix and run the check locally to see exactly which line
fails.

2026-09-21: recovery's "populated-data equality failure" was actually
its final mobile `scrollWidth <= innerWidth` assert at line 66, caused
by the same #744 needs-attention card overflow that broke
calm-return/discovery/reconnect. The needs-attention card only renders
when the owner has attention items, so its overflow broke four checks
at once.

**Note:** the diag scripts in `~/workspace/pr-browser-diagnosis/scripts/diag-*.mjs`
are Firefox sed-copies of the real checks for local reproduction; never
commit them.
