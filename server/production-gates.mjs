import { providerConfig } from './provider-config.mjs';
import { openJoinContract } from './open-contract.mjs';
import { validId } from '../src/events.js';

const CLERK_OPERATOR = /^idp-[a-f0-9]{64}$/;

export function isNamedOperatorId(value) {
  if (typeof value !== 'string' || value.includes('@')) return false;
  return CLERK_OPERATOR.test(value) || validId(value);
}

export function accountsMatchOperator(accountId, memberId, operatorAccountId) {
  if (!isNamedOperatorId(operatorAccountId || '')) return false;
  if (accountId === operatorAccountId || memberId === operatorAccountId) return true;
  return Boolean(memberId) && operatorAccountId.length === 6 && memberId.endsWith(operatorAccountId);
}

// Fail closed when ROOM_PRODUCTION=1. Clerk is optional when a local operator is named.
export function assertProductionReady(env, origin, { ship = openJoinContract().ship } = {}) {
  if (env.ROOM_PRODUCTION !== '1') {
    return { production: false, providerAuth: origin ? providerConfig(env, origin) : null, operatorAccountId: null };
  }
  const operatorAccountId = env.ROOM_OPERATOR_ACCOUNT_ID;
  if (!isNamedOperatorId(operatorAccountId || '')) {
    throw new Error('ROOM_PRODUCTION requires ROOM_OPERATOR_ACCOUNT_ID as idp-<64 hex> or a local account/member id');
  }
  const providerAuth = origin ? providerConfig(env, origin) : null;
  if (ship !== false) throw new Error('ROOM_PRODUCTION forbids shipping public MCP join');
  return { production: true, providerAuth, operatorAccountId };
}

export function cloudflareServiceMode(production) {
  return production ? 'cloudflare-production' : 'cloudflare-staging';
}
