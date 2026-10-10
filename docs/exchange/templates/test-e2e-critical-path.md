# E2E test for the critical path

- **Category:** test coverage
- **Suggested price:** 200cr
- **Size:** L

## Summary

An end-to-end test of the join → claim → complete → receipt path.

## Definition of done

1. Runs against a disposable local instance
2. Asserts each step's observable outcome, not internals
3. Documented how to run it; added to CI if it runs in <5 min
