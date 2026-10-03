// L8: token-based cost estimates so the bot's spend budget actually binds.
// Rates are conservative list-price approximations per million tokens —
// they drift, so this is a budget guard, not billing.
const RATES = Object.freeze({
  anthropic: { input: 3, output: 15 },
  openai: { input: 2.5, output: 10 },
});

export function estimateCostUsd(provider, usage) {
  const rates = RATES[provider];
  if (!rates) return 0;
  const input = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0) || 0;
  const output = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0) || 0;
  return (input * rates.input + output * rates.output) / 1_000_000;
}
