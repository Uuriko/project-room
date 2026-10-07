// Gateway metering prototype tests (200-hard-tasks #21).
// Contract guarded: the gateway measures tokens per job independently of
// what the provider reports, and the divergence report flags providers whose
// reports disagree with the metered counts beyond threshold. Credible
// regression: if metering ever trusted provider-reported usage, an
// under-reporting provider would bill less than it served and the report
// would stay silent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMeteredGateway, createMockComputeKit } from "../server/gateway-metering.mjs";
import { countTokens } from "../server/tokenizer.mjs";

const PROMPTS = {
  "job-a": "Summarize the following meeting notes in three bullet points.",
  "job-b": "Write a haiku about packet loss on a rainy Tuesday.",
  "job-c": "Explain why the sky is blue, in one paragraph for a ten-year-old.",
};
const COMPLETIONS = {
  "job-a": "- Decided to ship the metering prototype.\n- Tokenizer verified at 0% divergence.\n- Next: canary sampling design.",
  "job-b": "Rain on copper wire —\npackets fall like cherry blooms,\nroute tables in spring.",
  "job-c": "Sunlight looks white, but it is really a mix of colors. Air molecules scatter the blue part most, so the sky looks blue.",
};

function honestGateway() {
  return createMeteredGateway({ inference: createMockComputeKit({ completions: COMPLETIONS, skew: 0 }) });
}

describe("gateway metering", () => {
  it("measures prompt and completion tokens with the real tokenizer", async () => {
    const gw = honestGateway();
    const { metering } = await gw.meteredCall({ jobId: "job-a", model: "gpt-4o-mini", prompt: PROMPTS["job-a"] });
    assert.equal(metering.promptTokens, countTokens(PROMPTS["job-a"], "cl100k"));
    assert.equal(metering.completionTokens, countTokens(COMPLETIONS["job-a"], "cl100k"));
    assert.equal(metering.totalTokens, metering.promptTokens + metering.completionTokens);
    assert.ok(metering.latencyMs >= 0);
  });

  it("supports per-model tokenizer families", async () => {
    const gw = createMeteredGateway({
      inference: createMockComputeKit({ completions: COMPLETIONS }),
      family: "o200k",
    });
    const { metering } = await gw.meteredCall({ jobId: "job-b", model: "gpt-4o", prompt: PROMPTS["job-b"] });
    assert.equal(metering.family, "o200k");
    assert.equal(metering.promptTokens, countTokens(PROMPTS["job-b"], "o200k"));
  });

  it("flags an under-reporting provider beyond the divergence threshold", async () => {
    const gw = createMeteredGateway({ inference: createMockComputeKit({ completions: COMPLETIONS, skew: -0.25 }) });
    for (const jobId of Object.keys(PROMPTS)) {
      await gw.meteredCall({ jobId, model: "gpt-4o-mini", prompt: PROMPTS[jobId] });
    }
    const rep = gw.report({ divergenceThreshold: 0.02 });
    assert.equal(rep.jobs, 3);
    assert.equal(rep.flagged, 3);
    assert.ok(rep.meanAbsDivergence > 0.1, `expected large divergence, got ${rep.meanAbsDivergence}`);
  });

  it("does not flag an honest provider (within threshold)", async () => {
    const gw = honestGateway();
    for (const jobId of Object.keys(PROMPTS)) {
      // Override the provider report with the TRUE metered count: honest provider.
      const prompt = PROMPTS[jobId];
      const { result } = await gw.meteredCall({
        jobId,
        model: "gpt-4o-mini",
        prompt,
        providerReport: {
          promptTokens: countTokens(prompt, "cl100k"),
          completionTokens: countTokens(COMPLETIONS[jobId], "cl100k"),
        },
      });
      assert.ok(result.completion.length > 0);
    }
    const rep = gw.report({ divergenceThreshold: 0.02 });
    assert.equal(rep.flagged, 0);
    assert.equal(rep.meanAbsDivergence, 0);
  });

  it("handles jobs with no provider report (metering still recorded)", async () => {
    const gw = createMeteredGateway({
      inference: async () => ({ completion: "no usage attached" }),
    });
    const { metering } = await gw.meteredCall({ jobId: "job-x", model: "m", prompt: "hi" });
    assert.equal(metering.reportedTotalTokens, null);
    assert.equal(metering.divergence, null);
    assert.equal(gw.report().withReports, 0);
  });

  it("rejects a missing inference function", () => {
    assert.throws(() => createMeteredGateway({}), /inference function required/);
  });
});
