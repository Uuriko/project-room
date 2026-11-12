import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {verifyLocal} from '../scripts/verify-local.mjs';

// Local configuration is the authority. Conversation text supplies no commands,
// checkout paths, source revisions, credentials, or recipe options.
export function createLocalVerificationHost({binding, verification}) {
  const keys = ['origin','roomId','memberId','requestMessageId','requestRevision'];
  if (!binding || Object.keys(binding).some(key => !keys.includes(key))
    || keys.slice(0,4).some(key => typeof binding[key] !== 'string' || !binding[key] || binding[key].length > 2048)
    || !Number.isSafeInteger(binding.requestRevision) || binding.requestRevision < 0)
    throw Error('invalid_local_verification_binding');
  if (!verification || Object.keys(verification).some(key => !['checkout','expectedHead','baseSha','recipe','timeoutMs'].includes(key))
    || typeof verification.checkout !== 'string' || !isAbsolute(verification.checkout)
    || !/^[a-f0-9]{40}$/.test(verification.expectedHead ?? '') || !/^[a-f0-9]{40}$/.test(verification.baseSha ?? '')
    || verification.recipe !== 'affected-unit'
    || (verification.timeoutMs !== undefined && (!Number.isSafeInteger(verification.timeoutMs) || verification.timeoutMs < 100 || verification.timeoutMs > 1800000)))
    throw Error('invalid_local_verification_configuration');
  const pinned = Object.freeze({...binding}), options = Object.freeze({...verification});
  return async ({request,signal}, {binding: actual} = {}) => {
    if (!actual || ['origin','roomId','memberId','requestMessageId'].some(key => actual[key] !== pinned[key])
      || actual.expectedRequestRevision !== pinned.requestRevision || request?.id !== pinned.requestMessageId
      || request.revision !== pinned.requestRevision || request.recipientId !== pinned.memberId)
      throw Error('local_verification_binding_changed');
    signal?.throwIfAborted();
    const {receipt,path} = await verifyLocal({...options,signal});
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    // No test logs, local paths, environment values or arbitrary errors are posted.
    // This is a result for a formal request, not a work completion or CI approval.
    return {body:[
      `Local verification: ${receipt.status}.`,
      `Recipe: ${receipt.recipe}`,
      `Source: ${receipt.source.head}`,
      `Comparison base: ${receipt.source.base}`,
      `Selected test files: ${receipt.plan.files.length}; plan SHA-256: ${receipt.plan.sha256}`,
      `Environment: ${receipt.environment.node}; ${receipt.environment.platform}; ${receipt.environment.arch}`,
      `Started: ${receipt.startedAt}; finished: ${receipt.finishedAt}`,
      `Exit code: ${receipt.exitCode ?? 'unknown'}; reason: ${receipt.reason ?? 'none'}`,
      `Local receipt: ${receipt.runId}; SHA-256: ${digest}`,
      'Affected checks only. Local host-reported evidence; not full CI, independent review, or deployment approval.',
      receipt.status === 'passed' ? 'No execution exception detected.' : 'Investigation required; do not retry unchanged automatically.'
    ].join('\n')};
  };
}
