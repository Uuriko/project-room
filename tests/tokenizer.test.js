// Real tokenizer tests (200-hard-tasks #22).
// Contract guarded: token counts match the reference tokenizers
// (OpenAI tiktoken via js-tiktoken: cl100k_base, o200k_base, r50k_base)
// within 1% on a fixture battery — the counts below ARE the reference
// counts, measured 2026-10-07, so any rank-data corruption or BPE
// regression fails here. Credible regression: a dropped rank file or a
// broken merge loop would silently mis-meter every job the gateway counts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encode, countTokens, benchmark, SUPPORTED_FAMILIES } from "../server/tokenizer.mjs";

const FIXTURES = [
  ["Hello, world!", { cl100k: 4, o200k: 4, gpt2: 4 }],
  ["The quick brown fox jumps over the lazy dog. ".repeat(20), { cl100k: 201, o200k: 201, gpt2: 201 }],
  ["function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2); }", { cl100k: 25, o200k: 25, gpt2: 27 }],
  ["const x = await fetch('/api/rooms/123/events?limit=100');", { cl100k: 17, o200k: 17, gpt2: 19 }],
  ["日本語のテキストと emoji 🎉🚀 を混ぜたテスト", { cl100k: 24, o200k: 18, gpt2: 28 }],
  ["      indented\n\n\nmultiple\n\nnewlines\tand\ttabs", { cl100k: 11, o200k: 11, gpt2: 19 }],
  ["supercalifragilisticexpialidocious antidisestablishmentarianism", { cl100k: 17, o200k: 16, gpt2: 16 }],
  ["1234567890 3.14159 -42 +7 1e10", { cl100k: 17, o200k: 17, gpt2: 15 }],
  ["```js\nimport { strict as assert } from 'node:assert';\n```", { cl100k: 16, o200k: 16, gpt2: 19 }],
  ["<|endoftext|> is just text here, not special", { cl100k: 14, o200k: 14, gpt2: 14 }],
  ["a".repeat(5000), { cl100k: 625, o200k: 625, gpt2: 1250 }],
  ["Mixed CASE Words With APOSTROPHE's and contractions don't won't can't", { cl100k: 18, o200k: 14, gpt2: 20 }],
];

describe("tokenizer", () => {
  it("supports the three model families", () => {
    assert.deepEqual([...SUPPORTED_FAMILIES].sort(), ["cl100k", "gpt2", "o200k"]);
  });

  for (const family of SUPPORTED_FAMILIES) {
    it(`${family}: counts match the reference tokenizer within 1%`, () => {
      for (const [text, expected] of FIXTURES) {
        const ref = expected[family];
        const got = countTokens(text, family);
        const div = ref === 0 ? 0 : Math.abs(got - ref) / ref;
        assert.ok(div <= 0.01, `${family}: ${JSON.stringify(text.slice(0, 40))} ref=${ref} got=${got}`);
      }
    });
  }

  it("encode returns integer token ids and is deterministic", () => {
    const a = encode("Hello, world!", "cl100k");
    const b = encode("Hello, world!", "cl100k");
    assert.deepEqual(a, b);
    assert.ok(a.every((t) => Number.isInteger(t) && t >= 0));
    assert.equal(a.length, 4);
  });

  it("rejects unknown families", () => {
    assert.throws(() => countTokens("hi", "llama3"), /unknown tokenizer family/);
  });

  it("benchmarks at a usable rate for the metering path", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(200);
    const { tokensPerSec } = benchmark(text, "cl100k", 3);
    assert.ok(tokensPerSec > 5000, `too slow: ${tokensPerSec} tok/s`);
  });
});
