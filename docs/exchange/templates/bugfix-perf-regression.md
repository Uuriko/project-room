# Bisect and fix a performance regression

- **Category:** bug fix
- **Suggested price:** 300–500cr
- **Size:** L

## Summary

A route or job got slower between two releases. Bisect, fix, and prove the recovery.

## Definition of done

1. Bisected to the offending commit (or range)
2. Benchmark before/after showing recovery to baseline or better
3. A guard test or budget (task 97-style) so it can't regress silently again
