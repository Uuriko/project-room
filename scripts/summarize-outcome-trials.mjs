// Offline summary of explicitly recorded trials, not product telemetry.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const requiredText = (value, label) => {
  if (typeof value !== "string" || !value.trim()) throw Error(`Missing ${label}`);
  return value;
};
const timestamp = (value, label) => {
  requiredText(value, label);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw Error(`Invalid ${label}`);
  return Date.parse(value);
};
const measurement = (value, label) => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw Error(`Invalid ${label}; use null when unknown`);
  return value;
};
const median = values => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

export function summarizeOutcomeTrials(input, { asOf }) {
  const cutoff = timestamp(asOf, "asOf");
  if (input?.schemaVersion !== 1 || !Array.isArray(input.episodes)) throw Error("Expected schemaVersion 1 and episodes");
  const ids = new Set(), groups = new Map();
  for (const episode of input.episodes) {
    const id = requiredText(episode.outcomeId, "outcomeId");
    if (ids.has(id)) throw Error(`Duplicate outcomeId: ${id}; retries are one episode`);
    ids.add(id);
    const dimensions = Object.fromEntries(["taskClass", "actorType", "condition", "arm"].map(key => [key, requiredText(episode[key], key)]));
    requiredText(episode.actorId, "actorId");
    requiredText(episode.sourceRevision, "sourceRevision");
    requiredText(episode.rubricRevision, "rubricRevision");
    const start = timestamp(episode.startedAt, "startedAt"), deadline = timestamp(episode.deadlineAt, "deadlineAt");
    if (start > cutoff || deadline <= start) throw Error(`Invalid observation window: ${id}`);
    if (!["running", "accepted", "failed", "abandoned", "cancelled"].includes(episode.status)) throw Error(`Invalid status: ${id}`);
    const humanMinutes = measurement(episode.humanMinutes, "humanMinutes"), costUsd = measurement(episode.costUsd, "costUsd");
    if (episode.guardrailFindings !== null && (!Array.isArray(episode.guardrailFindings) || episode.guardrailFindings.some(f => !f || !["severe", "other"].includes(f.severity) || typeof f.reason !== "string" || !f.reason.trim()))) throw Error(`Invalid guardrailFindings: ${id}; use null when unobserved`);
    let acceptedAt = null;
    if (episode.status === "accepted") {
      const acceptance = episode.acceptance;
      requiredText(episode.artifactRevision, "artifactRevision");
      requiredText(acceptance?.reviewerId, "acceptance.reviewerId");
      if (acceptance?.artifactRevision !== episode.artifactRevision || acceptance?.rubricRevision !== episode.rubricRevision) throw Error(`Review does not match the exact artifact/rubric: ${id}`);
      if (episode.independentReviewRequired === true && acceptance.reviewerId === episode.actorId) throw Error(`Independent review missing: ${id}`);
      if (episode.guardrailFindings?.some(f => f.severity === "severe")) throw Error(`Severe guardrail failure cannot count as accepted: ${id}`);
      acceptedAt = timestamp(acceptance.at, "acceptance.at");
      if (acceptedAt < start || acceptedAt > cutoff) throw Error(`Invalid acceptance time: ${id}`);
    } else if (episode.acceptance != null) throw Error(`Acceptance attached to nonaccepted outcome: ${id}`);
    const key = JSON.stringify(dimensions);
    if (!groups.has(key)) groups.set(key, { dimensions, episodes: [] });
    groups.get(key).episodes.push({ ...episode, start, deadline, acceptedAt, humanMinutes, costUsd });
  }
  return {
    schemaVersion: 1, asOf, totalStarted: ids.size,
    caveat: "Recorded episodes only; no causal, customer-benefit or population claim. Unknown measurements remain unknown. Technical and user trials require distinct taskClass values.",
    groups: [...groups.values()].map(({ dimensions, episodes }) => {
      const matured = episodes.filter(e => e.deadline <= cutoff), immature = episodes.filter(e => e.deadline > cutoff);
      const accepted = matured.filter(e => e.acceptedAt !== null), onTime = accepted.filter(e => e.acceptedAt <= e.deadline);
      const human = matured.filter(e => e.humanMinutes !== null), costs = matured.filter(e => e.costUsd !== null);
      const totalHuman = human.reduce((sum, e) => sum + e.humanMinutes, 0), totalCost = costs.reduce((sum, e) => sum + e.costUsd, 0);
      return {
        ...dimensions, started: episodes.length, matured: matured.length,
        reviewedCompletion: { numerator: onTime.length, denominator: matured.length, rate: matured.length ? onTime.length / matured.length : null },
        timeToReviewedResult: { acceptedCount: accepted.length, medianMs: median(accepted.map(e => e.acceptedAt - e.start)), lateAcceptedCount: accepted.length - onTime.length },
        totalHumanEffort: { observedEpisodes: human.length, eligibleEpisodes: matured.length, observedMinutes: human.length ? totalHuman : null, meanMinutesPerEpisode: matured.length && human.length === matured.length ? totalHuman / matured.length : null },
        cost: { observedEpisodes: costs.length, eligibleEpisodes: matured.length, observedUsd: costs.length ? totalCost : null, usdPerAccepted: accepted.length && costs.length === matured.length ? totalCost / accepted.length : null },
        maturedStatuses: Object.fromEntries(["running", "accepted", "failed", "abandoned", "cancelled"].map(status => [status, matured.filter(e => e.status === status).length])),
        immature: { count: immature.length, earlyAccepted: immature.filter(e => e.acceptedAt !== null).length },
        pending: episodes.filter(e => e.status === "running").map(e => ({ outcomeId: e.outcomeId, ageMs: cutoff - e.start, overdue: e.deadline <= cutoff })),
        guardrails: { observedEpisodes: episodes.filter(e => e.guardrailFindings !== null).length, eligibleEpisodes: episodes.length, findings: episodes.flatMap(e => (e.guardrailFindings ?? []).map(f => ({ outcomeId: e.outcomeId, ...f }))) },
        evidence: episodes.map(e => ({ outcomeId: e.outcomeId, sourceRevision: e.sourceRevision, artifactRevision: e.artifactRevision ?? null, rubricRevision: e.rubricRevision, links: e.evidence ?? [] })),
      };
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [file, asOf, ...extra] = process.argv.slice(2);
    if (!file || !asOf || extra.length) throw Error("Usage: node scripts/summarize-outcome-trials.mjs <records.json> <as-of-ISO-with-zone>");
    console.log(JSON.stringify(summarizeOutcomeTrials(JSON.parse(readFileSync(file, "utf8")), { asOf }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
