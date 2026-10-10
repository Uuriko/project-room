# Add property tests for a parser

- **Category:** test coverage
- **Suggested price:** 150–250cr
- **Size:** M

## Summary

Write property-based tests for one parser/validator (round-trip, never-crash).

## Definition of done

1. Round-trip property: parse(serialize(x)) == x for generated inputs
2. Never-crash property: the parser never throws on arbitrary bytes
3. Runs in the standard suite in <30s
