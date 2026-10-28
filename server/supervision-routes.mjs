// Supervision inbox HTTP routes (herdr redesign, lane B6): the 9 routes under
// /api/rooms/{roomId}/supervision/cards* from phase1/inbox-mapping.md §2.7.
//
// Mounting is DEFERRED to the integration lane (do not mount in
// server/http.mjs from this lane; no runtime-package.mjs registration here).
// The intended mount mirrors handleWorkClaims:
//   if (supervisionMatch) {
//     return await handleSupervisionRoutes({ req, res, url, store, roomId, auth,
//       supervisionRoute, cardId, helpers: { json, reject, body },
//       deps: { store: supervisionCardStore, sources, nowMs } });
//   }
// where supervisionRoute ∈ {list,derive,seen,pick,retract,confirm,dismiss,
// snooze,refetch} and cardId is the path id for /cards/{id}/*.
//
// | Method + path                  | route key |
// | GET  /cards                    | list      |
// | POST /cards                    | derive    | (internal: roll-up tick, not clients)
// | POST /cards/{id}/seen          | seen      |
// | POST /cards/{id}/pick          | pick      |
// | POST /cards/{id}/retract       | retract   |
// | POST /cards/{id}/confirm       | confirm   |
// | POST /cards/{id}/dismiss       | dismiss   |
// | POST /cards/{id}/snooze        | snooze    |
// | POST /cards/{id}/refetch       | refetch   |
//
// Identity: cards are per-(room, operator). Every route re-authenticates the
// caller and scopes storage to the caller's own member id — a 404 means "no
// such card in YOUR queue", so agents can never clear another lane's state
// (server/inbox-approval.mjs precedent).
//
// Rate limits ride the shared checks at the http.mjs mounting point (same
// style as the other /api/rooms/ routes) — the integration lane wires them.
//
// Storage contract (B5's server/supervision-sqlite.mjs implements this;
// additive tables private_supervision_cards +
// private_supervision_card_history, registered in unfencedAdditiveTables):
//   createSupervisionCardStore(db) -> {
//     upsertCard(roomId, memberId, card)  // insert-or-update by
//                                         // (roomId, memberId, card.id); must
//                                         // never downgrade a terminal state
//     getCard(roomId, memberId, cardId)   // null when absent
//     listCards(roomId, memberId, { includeSnoozed }) // active cards only:
//                                         // excludes dispatched / resolved /
//                                         // dismissed / stale
//     journal(roomId, memberId, cardId, { at, event, from, to, note })
//     history(roomId, memberId, cardId)   // oldest first
//   }
//
// deps.sources (supplied by the roll-up tick / integration lane):
//   { claims[], messages[], replyRequests[], routerHints: Map,
//     nextClaimFor(fn), missingInputs: Map(claimId -> {summary, draft}) }
// Absent sources degrade to the card's derive-time context — the decider is
// pure and deterministic either way. Staleness is only ever asserted from
// affirmative live evidence (notification ≠ truth): unknown sources keep the
// card, they never retire it.
//
// deps.decide overrides the suggestion decider (default: the pure
// decideSuggestions). The integration lane's extension point for
// confirm-class suggestions — v1's decider never suggests money/merges/
// deploys, but the route's confirm gate is live for them.
import {
  SupervisionError,
  deriveCards,
  decideSuggestions,
  applyCardTransition,
  sortCards,
  DEFAULT_UNDO_HOLD_MS,
} from "./supervision.mjs";

const CARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SNOOZE_PRESETS_MS = {
  "1h": 3600_000,
  "4h": 4 * 3600_000,
  "tomorrow": 24 * 3600_000, // next-day re-arm, same time
};
const METHODS = {
  list: "GET", derive: "POST", seen: "POST", pick: "POST", retract: "POST",
  confirm: "POST", dismiss: "POST", snooze: "POST", refetch: "POST",
};

function supervisionHttpError(reject, error) {
  if (error instanceof SupervisionError) {
    switch (error.code) {
      case "invalid_input":
      case "confirmation_required":
      case "nothing_to_hold":
      case "not_confirm_gated":
        return reject(422, error.code, error.message);
      case "illegal_transition":
      case "undo_expired":
      case "undo_window_open":
      case "confirm_required":
        return reject(409, error.code, error.message);
      default:
        return reject(422, error.code, error.message);
    }
  }
  throw error;
}

export async function handleSupervisionRoutes({
  req, res, url, roomId, auth, supervisionRoute, cardId,
  helpers: { json, reject, body },
  deps = {},
}) {
  const route = supervisionRoute;
  if (!METHODS[route]) return reject(404, "unknown_supervision_route", `Unknown supervision route: ${route}`);
  if (req.method !== METHODS[route]) {
    return reject(405, "method_not_allowed", `${route} requires ${METHODS[route]}`);
  }
  const memberId = auth?.member?.id;
  if (typeof memberId !== "string" || memberId.length === 0) {
    return reject(401, "unauthorized", "Authentication required");
  }
  const store = deps.store;
  if (!store) return reject(500, "supervision_unwired", "The supervision card store is not wired yet (B5)");
  const sources = deps.sources ?? {};
  const decide = deps.decide ?? decideSuggestions;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs()
    : (typeof deps.nowMs === "number" ? deps.nowMs : Date.now());

  const load = id => {
    if (typeof id !== "string" || !CARD_ID_PATTERN.test(id)) {
      return reject(422, "invalid_input", "cardId must match [A-Za-z0-9_-]{1,128}");
    }
    const card = store.getCard(roomId, memberId, id);
    if (!card) return reject(404, "unknown_card", "No such card in your queue");
    return card;
  };
  const journaled = (card, from, event, note = null) => {
    store.journal(roomId, memberId, card.id, { at: nowMs, event, from, to: card.state, note });
  };
  const liveFor = card => {
    const ctx = card.context ?? {};
    const claims = Array.isArray(sources.claims) ? sources.claims : [];
    const messages = Array.isArray(sources.messages) ? sources.messages : [];
    const replyRequests = Array.isArray(sources.replyRequests) ? sources.replyRequests : [];
    const claim = ctx.claimId ? claims.find(c => c?.id === ctx.claimId) ?? null : null;
    const message = ctx.messageId ? messages.find(m => m?.id === ctx.messageId) ?? null : null;
    const replyRequest = ctx.replyRequestId
      ? replyRequests.find(r => r?.id === ctx.replyRequestId) ?? null : null;
    const routerHint = ctx.claimId && sources.routerHints instanceof Map
      ? sources.routerHints.get(ctx.claimId) ?? null : null;
    const missingInput = ctx.claimId && sources.missingInputs instanceof Map
      ? sources.missingInputs.get(ctx.claimId) ?? null : null;
    const nextClaim = ctx.nextClaim ?? (claim && typeof sources.nextClaimFor === "function"
      ? sources.nextClaimFor(claim) ?? null : null);
    return {
      roomId, claim, message, replyRequest, routerHint, missingInput, nextClaim,
    };
  };
  const withSuggestions = card =>
    Object.freeze({ ...card, suggestions: decide(card, liveFor(card)) });

  // Source liveness for stale-on-refetch. Returns true (still holds), false
  // (affirmatively resolved → stale), or null (unknown — keep the card).
  const sourceHolds = card => {
    const ctx = card.context ?? {};
    const { claim, message, replyRequest } = liveFor(card);
    const ref = card.sourceRef ?? {};
    if (ref.type === "claim") {
      if (!claim) return null;
      if (card.kind === "blocked_lane") return claim.state === "blocked";
      if (card.kind === "review_request") {
        const headOk = !ctx.headSha || (claim.pullRequest?.headSha ?? claim.headSha) === ctx.headSha;
        const stillNamed = (claim.reviewers ?? []).includes(memberId);
        const attested = (claim.reviews ?? [])
          .some(r => r?.memberId === memberId && (!ctx.headSha || r?.headSha === ctx.headSha));
        if (claim.state === "done") return false;
        return (headOk && stillNamed && !attested) ? true : false;
      }
      if (card.kind === "done_receipt") return true; // a receipt stands once derived
      return null;
    }
    if (ref.type === "message") {
      if (!message) return null;
      if (message.hasReplyFromOtherAuthors) return false;
      return true;
    }
    if (ref.type === "reply_request") {
      if (!replyRequest) return null;
      return replyRequest.status === "incoming";
    }
    return null;
  };

  const runTransition = (card, event) => {
    try {
      return applyCardTransition(card, event, { now: nowMs });
    } catch (error) {
      return supervisionHttpError(reject, error);
    }
  };

  switch (route) {
    case "list": {
      const includeSnoozed = url?.searchParams?.get("include") === "snoozed";
      const cards = store.listCards(roomId, memberId, { includeSnoozed });
      const withLive = cards.map(withSuggestions);
      return json(res, 200, {
        roomId, viewerId: memberId, cards: sortCards(withLive),
      });
    }

    case "derive": {
      // Internal: the roll-up tick derives from the event tail + claim table.
      // Upsert never downgrades a card the operator already triaged.
      const drafts = deriveCards({
        roomId, operatorId: memberId,
        claims: Array.isArray(sources.claims) ? sources.claims : [],
        messages: Array.isArray(sources.messages) ? sources.messages : [],
        replyRequests: Array.isArray(sources.replyRequests) ? sources.replyRequests : [],
        routerHints: sources.routerHints instanceof Map ? sources.routerHints : new Map(),
        nextClaimFor: typeof sources.nextClaimFor === "function" ? sources.nextClaimFor : null,
        now: nowMs,
      });
      let inserted = 0;
      for (const draft of drafts) {
        if (!store.getCard(roomId, memberId, draft.id)) {
          store.upsertCard(roomId, memberId, draft);
          journaled(draft, "—", "derived");
          inserted++;
        }
      }
      return json(res, 200, { roomId, derived: inserted, cards: sortCards(drafts.map(withSuggestions)) });
    }

    case "seen": {
      const card = load(cardId);
      const next = runTransition(card, { type: "focus" });
      store.upsertCard(roomId, memberId, next);
      journaled(next, card.state, "focus");
      return json(res, 200, { card: withSuggestions(next), seen: true });
    }

    case "pick": {
      const data = await body(req);
      const card = load(cardId);
      const suggestions = decide(card, liveFor(card));
      const index = data?.suggestionIndex;
      if (!Number.isInteger(index) || index < 1 || index > suggestions.length) {
        return reject(422, "invalid_input", `suggestionIndex must be 1..${suggestions.length}`);
      }
      const suggestion = suggestions[index - 1];
      if (suggestion.gate === "confirm") {
        // Confirm-only class: open the challenge sheet, record nothing yet.
        const next = runTransition(card, { type: "start_confirm", suggestion });
        store.upsertCard(roomId, memberId, next);
        journaled(next, card.state, "start_confirm", suggestion.kind);
        return json(res, 200, {
          card: withSuggestions(next),
          requiresConfirm: true,
          challenge: { suggestion, badge: suggestion.badge },
        });
      }
      if (suggestion.gate === "none") {
        return reject(422, "nothing_to_hold", "navigation-only suggestions record no intent — follow the deep link");
      }
      const holdMs = data?.holdMs ?? DEFAULT_UNDO_HOLD_MS;
      const next = runTransition(card, { type: "pick", suggestion, holdMs });
      store.upsertCard(roomId, memberId, next);
      journaled(next, card.state, "pick", suggestion.kind);
      return json(res, 200, {
        card: withSuggestions(next),
        suggestion,
        intent: {
          journaled: true,
          undoDeadlineMs: next.undoDeadlineMs,
          badge: suggestion.badge,
          note: "the room write is held — retract before the deadline; nothing was fired yet",
        },
      });
    }

    case "retract": {
      const card = load(cardId);
      const next = runTransition(card, { type: "retract" });
      store.upsertCard(roomId, memberId, next);
      journaled(next, card.state, "retract");
      return json(res, 200, { card: withSuggestions(next), retracted: true });
    }

    case "confirm": {
      const data = await body(req);
      if (data?.confirm !== true) {
        return reject(422, "confirmation_required", "confirm-class actions need {confirm:true}");
      }
      const card = load(cardId);
      // Idempotent replay: if the first /confirm response was lost, the card
      // is already approved (pending_undo, confirm-gated, not yet fired). A
      // retry must hand back the same approved write instead of 409ing,
      // otherwise the action stays approved but is never fired.
      if (card.state === "pending_undo" && card.pickedSuggestion?.gate === "confirm") {
        return json(res, 200, {
          confirmed: true,
          replayed: true,
          card: withSuggestions(card),
          write: card.pickedSuggestion?.api ?? null,
          apiNote: card.pickedSuggestion?.apiNote ?? null,
        });
      }
      const next = runTransition(card, { type: "confirm", confirmed: true });
      store.upsertCard(roomId, memberId, next);
      journaled(next, card.state, "confirm", next.pickedSuggestion?.kind ?? null);
      return json(res, 200, {
        confirmed: true,
        card: withSuggestions(next),
        // The write is approved and fires immediately — the undo window is
        // zero ("cannot be undone"). The client issues the approved payload
        // on return and reports delivery via POST …/refetch {fired:true}.
        write: next.pickedSuggestion?.api ?? null,
        apiNote: next.pickedSuggestion?.apiNote ?? null,
      });
    }

    case "dismiss": {
      const data = await body(req);
      const card = load(cardId);
      const next = runTransition(card, { type: "dismiss", note: data?.note ?? null });
      store.upsertCard(roomId, memberId, next);
      journaled(next, card.state, "dismiss", next.dismissNote);
      return json(res, 200, { card: withSuggestions(next), dismissed: true });
    }

    case "snooze": {
      const data = await body(req);
      const card = load(cardId);
      let untilMs = data?.untilMs ?? null;
      if (data?.snoozeFor !== undefined && data?.snoozeFor !== null) {
        const preset = SNOOZE_PRESETS_MS[data.snoozeFor];
        if (preset === undefined) {
          return reject(422, "invalid_input", "snoozeFor must be 1h, 4h, tomorrow, or supply untilMs");
        }
        untilMs = nowMs + preset;
      }
      if (untilMs === null) {
        return reject(422, "invalid_input", "snooze needs snoozeFor (1h|4h|tomorrow) or untilMs");
      }
      const next = runTransition(card, { type: "snooze", untilMs });
      store.upsertCard(roomId, memberId, next);
      journaled(next, card.state, "snooze");
      return json(res, 200, { card: withSuggestions(next), snoozedUntilMs: next.snoozedUntilMs });
    }

    case "refetch": {
      const data = await body(req);
      const card = load(cardId);
      if (data?.fired === true) {
        // v1 client-held dispatch: the client fired the held write on lapse
        // and reports delivery; the card becomes dispatched with the receipt.
        const next = runTransition(card, { type: "fired" });
        store.upsertCard(roomId, memberId, next);
        journaled(next, card.state, "fired");
        return json(res, 200, { card: withSuggestions(next), fired: true });
      }
      const holds = sourceHolds(card);
      if (holds === false) {
        const next = runTransition(card, { type: "mark_stale" });
        store.upsertCard(roomId, memberId, next);
        journaled(next, card.state, "mark_stale", "resolved elsewhere");
        return json(res, 200, { card: withSuggestions(next), stale: true });
      }
      // holds === true: still live. holds === null: cannot verify — keep the
      // card (notification ≠ truth; unknown sources never retire a card).
      return json(res, 200, { card: withSuggestions(card), stale: false, verified: holds === true });
    }

    default:
      return reject(404, "unknown_supervision_route", `Unknown supervision route: ${route}`);
  }
}
