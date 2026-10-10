// Gateway-side metering prototype (200-hard-tasks #21).
// A metering layer that sits on the gateway path and measures tokens/job
// INDEPENDENTLY of provider-reported usage, using the real tokenizer
// (server/tokenizer.mjs, task #22). It wraps a compute-kit-style inference
// function: every call is intercepted, prompt + completion are tokenized
// locally, and the metered counts are recorded alongside whatever the
// provider reported. Divergence reports expose providers whose reported
// usage does not match the metered usage.
// Pure module: the wrapped inference function is injected (local mock here).
import { countTokens } from "./tokenizer.mjs";

export function createMeteredGateway({ inference, family = "cl100k", clock = () => Date.now() } = {}) {
  if (typeof inference !== "function") throw new Error("createMeteredGateway: inference function required");
  const ledger = []; // per-job metering records

  async function meteredCall({ jobId, model, prompt, providerReport = null, ...rest }) {
    const promptTokens = countTokens(prompt, family);
    const startedAt = clock();
    const result = await inference({ jobId, model, prompt, ...rest });
    const latencyMs = clock() - startedAt;
    const completion = result && typeof result.completion === "string" ? result.completion : "";
    const completionTokens = countTokens(completion, family);
    const reported = providerReport || result.usage || null;
    const record = {
      jobId,
      model,
      family,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      reportedPromptTokens: reported?.promptTokens ?? null,
      reportedCompletionTokens: reported?.completionTokens ?? null,
      reportedTotalTokens:
        reported?.totalTokens ?? (reported ? (reported.promptTokens ?? 0) + (reported.completionTokens ?? 0) : null),
      latencyMs,
      at: new Date(startedAt).toISOString(),
    };
    record.divergence = divergenceOf(record);
    ledger.push(Object.freeze(record));
    return { result, metering: record };
  }

  function divergenceOf(record) {
    if (record.reportedTotalTokens == null) return null;
    const measured = record.totalTokens;
    const reported = record.reportedTotalTokens;
    if (measured === 0) return reported === 0 ? 0 : 1;
    return (reported - measured) / measured; // +over-report, -under-report
  }

  function report({ divergenceThreshold = 0.02 } = {}) {
    const measured = ledger.filter((r) => r.reportedTotalTokens != null);
    const flagged = measured.filter((r) => Math.abs(r.divergence) > divergenceThreshold);
    const divergences = measured.map((r) => r.divergence);
    return {
      jobs: ledger.length,
      withReports: measured.length,
      flagged: flagged.length,
      flaggedJobIds: flagged.map((r) => r.jobId),
      meanAbsDivergence: divergences.length
        ? divergences.reduce((a, d) => a + Math.abs(d), 0) / divergences.length
        : null,
      maxAbsDivergence: divergences.length ? Math.max(...divergences.map(Math.abs)) : null,
      records: ledger.slice(),
    };
  }

  return { meteredCall, report, ledger: () => ledger.slice(), divergenceOf };
}

// Local mock of the compute kit: returns a completion plus a provider
// usage report. `skew` lets fixtures simulate honest, under-reporting and
// over-reporting providers deterministically.
export function createMockComputeKit({ completions = {}, skew = 0, latencyMs = 5 } = {}) {
  return async function mockInference({ jobId, model, prompt }) {
    const completion = completions[jobId] ?? `mock completion for ${jobId} (model ${model})`;
    const promptTokens = prompt.split(/\s+/).filter(Boolean).length; // naive provider-side count
    const completionTokens = completion.split(/\s+/).filter(Boolean).length;
    const skewed = (n) => Math.max(0, Math.round(n * (1 + skew)));
    await new Promise((r) => setTimeout(r, latencyMs));
    return {
      completion,
      usage: {
        promptTokens: skewed(promptTokens),
        completionTokens: skewed(completionTokens),
        totalTokens: skewed(promptTokens + completionTokens),
      },
    };
  };
}
