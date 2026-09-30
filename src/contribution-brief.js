// Offer-specific public copy: neither private execution bindings nor costs.
import { OFFER_FIELDS, prepareWorkOffer, preparePaidWork } from './paid-work-offers.js';
const fail = message => { throw new Error(message); };
const exact = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail('Invalid contribution fields');
};
const positive = value => typeof value === 'string' && /^[1-9][0-9]{0,17}$/.test(value);
const display = (raw, decimals) => { const value = raw.padStart(decimals + 1, '0'); return `${value.slice(0, -decimals)}.${value.slice(-decimals)}`; };
export function prepareContributionBrief(input, options = {}) {
  exact(input, [...OFFER_FIELDS, 'reward', 'costsMinor', 'platformFeeBps']);
  const common = Object.fromEntries(OFFER_FIELDS.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
  const reward = input.reward;
  exact(reward, ['kind', 'unit', 'amountMinor', 'decimals', 'terms', 'basis']);
  if (!['cash', 'work_trade', 'unpaid'].includes(reward.kind)) fail('Choose work_trade, cash or unpaid reward');
  if (typeof reward.terms !== 'string' || reward.terms.length > 600 || /[\x00-\x1f\x7f]/.test(reward.terms)) fail('Invalid reward terms');
  if (reward.basis !== 'fixed') fail('This compiler supports fixed rewards');
  const decimals = reward.kind === 'cash' ? ({ USD: 2, USDC: 6 })[reward.unit] : 3;
  if (decimals === undefined || reward.decimals !== decimals || reward.kind !== 'cash' && reward.unit !== 'credit') fail('Reward unit and decimals do not match');
  if (reward.kind === 'unpaid' ? reward.amountMinor !== '0' : !positive(reward.amountMinor)) fail('Invalid reward amountMinor');
  if (reward.kind === 'cash') {
    const prepared = preparePaidWork({ ...common, currency: reward.unit, amountMinor: reward.amountMinor,
      platformFeeBps: input.platformFeeBps ?? 0, costsMinor: input.costsMinor ?? { labor: '0', tools: '0', other: '0' } }, options);
    return { ...prepared, publicTerms: { ...prepared.publicTerms, reward: { ...reward } } };
  }
  if (input.costsMinor !== undefined || input.platformFeeBps !== undefined) fail('Cash estimates and fees are not credit or unpaid terms');
  const base = prepareWorkOffer(common, options);
  const rewardText = reward.kind === 'work_trade'
    ? `Proposed work trade: ${display(reward.amountMinor, 3)} internal credits. Credits are not USD or a confirmed cash-out balance.`
    : 'Unpaid contribution. No monetary or credit reward.';
  const terms = [base.terms, rewardText, reward.terms, 'Proposed terms only; no funds or credits reserved. This proposal grants no external execution or spending permission.'].join('\n');
  if (terms.length > 4096) fail('Contribution terms exceed Room definition limit');
  return { schema: 'room-contribution-brief/1', commercialStatus: 'draft_offer', paymentStatus: reward.kind === 'work_trade' ? 'ledger_only' : 'not_applicable', approval: base.approval,
    publicTerms: { ...base.publicTerms, reward: { ...reward }, fundingStatus: reward.kind === 'work_trade' ? 'ledger_only' : 'not_applicable', paymentStatus: reward.kind === 'work_trade' ? 'ledger_only' : 'not_applicable' },
    command: { ...base.command, data: { ...base.command.data, definitionOfDone: terms } } };
}
export function publicContribution(prepared) {
  return structuredClone(prepared.publicTerms);
}
// Accepts the public API shape directly; downloading a skill needs no private IDs.
export function renderPublicContributionTerms(terms, { skill = false } = {}) {
  if (!terms || !['task', 'project'].includes(terms.kind) || !['human', 'agent', 'human_with_agent_review'].includes(terms.approvalPolicy?.mode)) fail('Invalid public offer terms');
  for (const key of ['title', 'summary']) if (typeof terms[key] !== 'string' || !terms[key].trim() || terms[key].length > 600 || /[\x00-\x1f\x7f]/.test(terms[key])) fail('Invalid public offer text');
  for (const key of ['acceptanceCriteria', 'exclusions']) if (!Array.isArray(terms[key]) || terms[key].length > 8 || terms[key].some(value => typeof value !== 'string' || value.length > 300)) fail('Invalid public offer criteria');
  for (const key of ['schema', 'id', 'repositoryUrl', 'deadline']) if (terms[key] !== undefined && (typeof terms[key] !== 'string' || terms[key].length > 2048)) fail('Invalid public offer metadata');
  if (terms.version !== undefined && (!Number.isSafeInteger(terms.version) || terms.version < 1)) fail('Invalid public offer version');
  const reward = terms.reward;
  if (!reward || !['cash', 'work_trade', 'unpaid'].includes(reward.kind) || !['credit', 'USD', 'USDC'].includes(reward.unit)
    || typeof reward.amountMinor !== 'string' || !/^(0|[1-9][0-9]{0,17})$/.test(reward.amountMinor) || typeof reward.terms !== 'string' || reward.terms.length > 600
    || !['fixed', 'pool'].includes(reward.basis)) fail('Invalid public reward');
  const expectedDecimals = reward.unit === 'USD' ? 2 : reward.unit === 'USDC' ? 6 : 3;
  if (reward.decimals !== expectedDecimals || reward.kind === 'cash' && reward.unit === 'credit' || reward.kind !== 'cash' && reward.unit !== 'credit') fail('Invalid public reward unit');
  const publicValue = Object.fromEntries(['schema', 'id', 'version', 'kind', 'title', 'summary', 'acceptanceCriteria', 'exclusions', 'repositoryUrl', 'deadline', 'reward', 'approvalPolicy', 'fundingStatus', 'paymentStatus'].filter(key => Object.hasOwn(terms, key)).map(key => [key, terms[key]]));
  // Nested whitelists prevent accidentally forwarding private API extensions.
  publicValue.reward = Object.fromEntries(['kind', 'unit', 'amountMinor', 'decimals', 'terms', 'basis'].filter(key => Object.hasOwn(terms.reward, key)).map(key => [key, terms.reward[key]]));
  publicValue.approvalPolicy = { mode: terms.approvalPolicy.mode };
  const status = terms.reward.kind === 'cash' ? 'not_configured' : terms.reward.kind === 'work_trade' ? 'ledger_only' : 'not_applicable';
  publicValue.fundingStatus = status;
  publicValue.paymentStatus = status;
  const json = JSON.stringify(publicValue, null, 2);
  const fence = '`'.repeat(Math.max(2, ...[...json.matchAll(/`+/g)].map(match => match[0].length)) + 1);
  return [skill ? '---\nname: project-room-contribution-offer\ndescription: "Deliver this public contribution offer using its selected acceptance policy."\n---' : '# Project Room contribution offer',
    `${fence}json\n${json}\n${fence}`,
    'Confirm the current offer and obtain authorized Room access before claiming or submitting work. Use the existing work tools and exact evidence version for independent review. Retain the same request identity when retrying an uncertain write.',
    'Acceptance policy is selected by the owner; current Room permissions and required human decisions still apply. This brief grants no access or execution permission.',
    'Internal credits are separate from cash and are not automatically redeemable. Cash terms require configured funding and verified payment; publication and work acceptance alone do not transfer money.', ''].join('\n\n');
}
export function contributionMarkdown(prepared, options) { return renderPublicContributionTerms(publicContribution(prepared), options); }
