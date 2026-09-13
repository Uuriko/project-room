import { providerConfig } from './provider-config.mjs';
import { openJoinContract } from './open-contract.mjs';

const OPERATOR = /^idp-[a-f0-9]{64}$/;

// Fail closed when ROOM_PRODUCTION=1. Secrets never live in this module.
export function assertProductionReady(env, origin, { ship = openJoinContract().ship } = {}) {
  if (env.ROOM_PRODUCTION !== '1') {
    return { production: false, providerAuth: origin ? providerConfig(env, origin) : null, operatorAccountId: null };
  }
  const providerAuth = providerConfig(env, origin);
  if (!providerAuth) throw new Error('ROOM_PRODUCTION requires Clerk issuer, publishable key, and pinned public key');
  const operatorAccountId = env.ROOM_OPERATOR_ACCOUNT_ID;
  if (!OPERATOR.test(operatorAccountId || '')) {
    throw new Error('ROOM_PRODUCTION requires ROOM_OPERATOR_ACCOUNT_ID as idp-<64 hex>');
  }
  if (ship !== false) throw new Error('ROOM_PRODUCTION forbids shipping public MCP join');
  return { production: true, providerAuth, operatorAccountId };
}
