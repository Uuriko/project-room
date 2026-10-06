// Buyer-offer HTTP routes — Demigod buyer-facing layer.
//
// Room-scoped routes mounted by server/http.mjs inside the authenticated
// room block, after the shared credential, fence and rate-limit checks —
// the same mounting pattern as server/feedback-routes.mjs. http.mjs owns
// one anchored regex literal per route template (the route-docs gate
// extracts those literals) and passes the resolved route name here:
//
//   offers-list | offers-create            /demigod-offers
//   offer-read | offer-document            /demigod-offers/{id}[/document]
//   offer-present|accept|decline|expire|withdraw
//   contracts-list | contracts-create      /demigod-contracts
//   contract-read                          /demigod-contracts/{id}
//   contract-acknowledge|complete|terminate
//   loops-list | loops-create              /signoff-loops
//   loop-read | loop-status                /signoff-loops/{id}[/status]
//   loop-submit|review|cancel
//
// Identity: the caller's lane is the authenticated member id; a
// body-claimed id that disagrees is rejected — identity spoofing is junk by
// construction. Guests may read but never write (same as /feedback).
//
// Error contract: the domain modules throw errors carrying .status/.code;
// they pass through here. Unknown errors rethrow for the generic 500 path —
// never wrapped, so no internal detail leaks.
//
// RECORD-ONLY: every response body for a money-shaped field carries
// recordOnly/paymentStatus markers from the domain records. Nothing here
// moves money.
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";

const READ_ROUTES = new Set(['offers-list', 'offer-read', 'offer-document', 'contracts-list', 'contract-read', 'loops-list', 'loop-read', 'loop-status']);
const WRITE_ROUTES = new Set(['offers-create', 'offer-present', 'offer-accept', 'offer-decline', 'offer-expire', 'offer-withdraw',
  'contracts-create', 'contract-acknowledge', 'contract-complete', 'contract-terminate',
  'loops-create', 'loop-submit', 'loop-review', 'loop-cancel']);

export async function handleBuyerOffers({ req, res, url, store, roomId, buyerOfferRoute, buyerOfferId, reauthorize, helpers }) {
  const { json, reject, body } = helpers;
  const fail = error => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const code = typeof error?.code === 'string' ? error.code : 'internal_error';
    reject(status, code, status === 500 ? 'Internal error' : String(error?.message ?? 'Internal error'));
  };
  try {
    if (!READ_ROUTES.has(buyerOfferRoute) && !WRITE_ROUTES.has(buyerOfferRoute)) {
      return reject(404, 'not_found', 'Unknown buyer-offer route');
    }
    const current = reauthorize ? reauthorize() : null;
    const actorId = current?.member?.id;
    if (!actorId) reject(401, 'auth_required', 'Authentication required');
    if (isGuestAgentMemberId(actorId) && WRITE_ROUTES.has(buyerOfferRoute)) {
      reject(403, 'guest_scope_denied', 'Guest members cannot perform this action');
    }
    const method = req.method;
    const query = name => url.searchParams.get(name);
    const offers = store.demigodOffers;
    const contracts = store.demigodContracts;
    const loops = store.buyerSignoff;

    switch (buyerOfferRoute) {
      case 'offers-list':
        if (method !== 'GET' && method !== 'HEAD') return reject(405, 'method_not_allowed', 'Use GET');
        return json(res, 200, offers.list(roomId, { limit: query('limit') ?? 20, after: query('after') }), method === 'HEAD');
      case 'offers-create':
        if (method !== 'POST') return reject(405, 'method_not_allowed', 'Use POST');
        return json(res, 201, offers.create(roomId, actorId, await body(req)));
      case 'offer-read':
        if (method !== 'GET' && method !== 'HEAD') return reject(405, 'method_not_allowed', 'Use GET');
        return json(res, 200, offers.get(roomId, buyerOfferId), method === 'HEAD');
      case 'offer-document': {
        if (method !== 'GET' && method !== 'HEAD') return reject(405, 'method_not_allowed', 'Use GET');
        const doc = offers.document(roomId, buyerOfferId);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': Buffer.byteLength(doc) });
        return res.end(method === 'HEAD' ? undefined : doc);
      }
      case 'offer-present': case 'offer-accept': case 'offer-decline': case 'offer-expire': case 'offer-withdraw':
        if (method !== 'POST') return reject(405, 'method_not_allowed', 'Use POST');
        return json(res, 200, offers[buyerOfferRoute.slice('offer-'.length)](roomId, actorId, buyerOfferId, await body(req)));
      case 'contracts-list':
        if (method !== 'GET' && method !== 'HEAD') return reject(405, 'method_not_allowed', 'Use GET');
        return json(res, 200, contracts.list(roomId, { limit: query('limit') ?? 20, after: query('after') }), method === 'HEAD');
      case 'contracts-create':
        if (method !== 'POST') return reject(405, 'method_not_allowed', 'Use POST');
        return json(res, 201, contracts.create(roomId, actorId, await body(req)));
      case 'contract-read':
        if (method !== 'GET' && method !== 'HEAD') return reject(405, 'method_not_allowed', 'Use GET');
        return json(res, 200, contracts.get(roomId, buyerOfferId), method === 'HEAD');
      case 'contract-acknowledge': case 'contract-complete': case 'contract-terminate':
        if (method !== 'POST') return reject(405, 'method_not_allowed', 'Use POST');
        return json(res, 200, contracts[buyerOfferRoute.slice('contract-'.length)](roomId, actorId, buyerOfferId, await body(req)));
      case 'loops-list':
        if (method !== 'GET' && method !== 'HEAD') return reject(405, 'method_not_allowed', 'Use GET');
        return json(res, 200, loops.list(roomId, { limit: query('limit') ?? 20, after: query('after') }), method === 'HEAD');
      case 'loops-create':
        if (method !== 'POST') return reject(405, 'method_not_allowed', 'Use POST');
        return json(res, 201, loops.create(roomId, actorId, await body(req)));
      case 'loop-read':
        if (method !== 'GET' && method !== 'HEAD') return reject(405, 'method_not_allowed', 'Use GET');
        return json(res, 200, loops.get(roomId, buyerOfferId), method === 'HEAD');
      case 'loop-status':
        if (method !== 'GET' && method !== 'HEAD') return reject(405, 'method_not_allowed', 'Use GET');
        return json(res, 200, loops.status(roomId, buyerOfferId), method === 'HEAD');
      case 'loop-submit': case 'loop-review': case 'loop-cancel':
        if (method !== 'POST') return reject(405, 'method_not_allowed', 'Use POST');
        return json(res, 200, loops[buyerOfferRoute.slice('loop-'.length)](roomId, actorId, buyerOfferId, await body(req)));
      default:
        return reject(404, 'not_found', 'Unknown buyer-offer route');
    }
  } catch (error) {
    fail(error);
  }
}
