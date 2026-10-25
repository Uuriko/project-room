// A partial workload is not comparable with a fully successful workload.
// Keep raw timings for diagnosis, but invalidate the whole metric comparison.
export function qualifiedSamples(samples, key, pick) {
  const isWrite = key === "writeP50Ms" || key === "writeP95Ms";
  const invalid = samples.some(sample => (sample.fixtureFailures ?? 0) > 0
    || (isWrite && (sample.writeFailures ?? 0) > 0));
  return samples.map(sample => invalid ? NaN : (pick(sample) ?? NaN));
}
