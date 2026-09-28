// Commercial briefs compile to the existing work protocol. Prices are quotes,
// never evidence of funding; internal estimates never enter the room command.
import { validId } from "./events.js";

export const PAID_WORK_OFFERS = Object.freeze([
  Object.freeze({ id: "software-change", title: "Bounded software change", deliverable: "A reviewable patch with a reproduction, acceptance checks and handoff notes." }),
  Object.freeze({ id: "research-brief", title: "Evidence-backed research brief", deliverable: "A decision-ready brief with primary sources, alternatives and explicit uncertainties." }),
  Object.freeze({ id: "business-automation", title: "Business automation", deliverable: "A bounded workflow with representative input/output checks and an operator handoff." })
]);

const fail = message => { throw new Error(message); };
const text = (value, name, limit = 600) => {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) fail(`Invalid ${name}`);
  return value.trim();
};
const id = (value, name) => { if (!validId(value)) fail(`Invalid ${name}`); return value; };
const amount = (value, name) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,17})$/.test(value)) fail(`${name} must be an integer minor-unit string (at most 18 digits)`);
  return BigInt(value);
};
const list = (value, name, required = true) => {
  if (!Array.isArray(value) || value.length > 8 || (required && !value.length)) fail(`Invalid ${name}`);
  return value.map(v => text(v, name, 300));
};
const keys = (object, allowed, name) => {
  if (!object || typeof object !== "object" || Array.isArray(object) || Object.keys(object).some(k => !allowed.includes(k))) fail(`Invalid ${name} fields`);
};
const display = (raw, decimals) => {
  const value = raw.toString().padStart(decimals + 1, "0");
  return `${value.slice(0, -decimals)}.${value.slice(-decimals)}`;
};

export function preparePaidWork(input) {
  keys(input, ["requestId", "workItemId", "accountableMemberId", "humanDecisionMakerId", "verifierMemberId", "offerId", "outcome", "acceptanceCriteria", "exclusions", "currency", "amountMinor", "costsMinor", "platformFeeBps"], "brief");
  const offer = PAID_WORK_OFFERS.find(candidate => candidate.id === input.offerId);
  if (!offer) fail("Unknown offerId");
  const requestId = id(input.requestId, "requestId");
  const workItemId = id(input.workItemId, "workItemId");
  const accountableMemberId = id(input.accountableMemberId, "accountableMemberId");
  const humanDecisionMakerId = id(input.humanDecisionMakerId, "humanDecisionMakerId");
  const verifierMemberId = id(input.verifierMemberId, "verifierMemberId");
  if (verifierMemberId === accountableMemberId) fail("Verifier must be independent of the accountable member");
  if (!["USD", "USDC"].includes(input.currency)) fail("currency must be USD or USDC; ledger credits are not money");
  const decimals = input.currency === "USD" ? 2 : 6;
  const gross = amount(input.amountMinor, "amountMinor");
  if (gross === 0n) fail("A commercial quote must have a positive amount");
  keys(input.costsMinor, ["labor", "tools", "other"], "costsMinor");
  const cost = ["labor", "tools", "other"].reduce((sum, key) => sum + amount(input.costsMinor[key], `costsMinor.${key}`), 0n);
  if (!Number.isInteger(input.platformFeeBps) || input.platformFeeBps < 0 || input.platformFeeBps > 10000) fail("platformFeeBps must be an integer from 0 to 10000");
  // Floor in asset minor units; disclosed explicitly in the quote.
  const fee = gross * BigInt(input.platformFeeBps) / 10000n;
  const net = gross - fee;
  const outcome = text(input.outcome, "outcome", 160);
  const criteria = list(input.acceptanceCriteria, "acceptanceCriteria");
  const exclusions = list(input.exclusions ?? [], "exclusions", false);
  const quoteText = [
    `${offer.title}: ${outcome}`, offer.deliverable,
    "Acceptance criteria:", ...criteria.map((v, i) => `${i + 1}. ${v}`),
    ...(exclusions.length ? ["Out of scope:", ...exclusions.map(v => `- ${v}`)] : []),
    `Proposed total: ${display(gross, decimals)} ${input.currency}.`,
    `Proposed platform fee, included in total: ${input.platformFeeBps} basis points (${display(fee, decimals)} ${input.currency}; rounded down to asset minor units).`,
    `Provider proceeds before costs: ${display(net, decimals)} ${input.currency}.`,
    "Commercial status: draft quote; customer agreement and payment setup are pending. No funds received or reserved.",
    "Room review/completion does not prove customer acceptance or payment. Agree delivery date, revisions, payment timing, taxes, refunds and usage rights before starting paid delivery.",
    "This proposal grants no external execution or spending permission."
  ].join("\n");
  if (quoteText.length > 4096) fail("Quote exceeds Room's 4096-character definition limit; shorten criteria or exclusions");
  return {
    schema: "room-paid-work-brief/1",
    commercialStatus: "draft_quote",
    paymentStatus: "not_configured",
    quote: { offerId: offer.id, currency: input.currency, decimals, amountMinor: gross.toString(), platformFeeBps: input.platformFeeBps, feeMinor: fee.toString(), providerProceedsMinor: net.toString(), text: quoteText },
    privateEstimate: { costMinor: cost.toString(), contributionMinor: (net - cost).toString(), contributionBps: ((net - cost) * 10000n / gross).toString(), profitable: net > cost, note: "Estimate only; excludes any unentered payment, tax, refund or operating costs. Not revenue." },
    command: { id: requestId, type: "work.proposed", data: {
      workItemId, title: `[Offer] ${outcome}`, definitionOfDone: quoteText,
      accountableMemberId, humanDecisionMakerId, verifierMemberId,
      mode: "read", independentVerificationRequired: true, ownerDecisionRequired: true
    } }
  };
}
