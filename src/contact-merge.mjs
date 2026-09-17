/**
 * contact-merge.mjs — Pure contact identity-resolution + merge planner.
 *
 * Two jobs, no side effects:
 *   1. Identity resolution: score every pair of contacts for "same person"
 *      likelihood from shared identifiers.
 *   2. Merge planning: given a candidate pair, produce a deterministic
 *      field-resolution plan, preview the merged record (dry run), and walk
 *      the plan through proposed → approved → merged with explicit conflict
 *      resolution when the precedence rules cannot pick a winner.
 *
 * Contact record shape (as stored):
 *   {
 *     id: string,
 *     names: string[],                                  // free-form names
 *     emails: [{ address, verified: boolean, seenAt }], // seenAt = ms epoch
 *     phones: [{ number, seenAt }],
 *     channels: { [channelName]: handle },              // e.g. { x: '@alice' }
 *     status: 'active' | 'merged',                      // merged = superseded
 *     mergedInto: string | null,
 *   }
 * Shorthand input is accepted: emails/phones may be plain strings (treated as
 * unverified email / phone seen at the injected clock) and missing id is
 * generated via deps.id.
 *
 * Scoring (identity resolution):
 *   - exact normalized email match          → strong link (weights.emailMatch)
 *   - exact normalized phone match (digits) → strong link (weights.phoneMatch)
 *   - normalized name equal AND a shared channel key with an equal handle
 *                                           → weak link (weights.nameChannelMatch)
 *   A name match ALONE contributes nothing — common names never merge on
 *   their own. Pair score is the sum of link weights; pairs at or above
 *   weights.threshold are surfaced by findCandidates().
 *
 * Field-resolution precedence (deterministic — never "longest wins"):
 *   - names:      union, first-seen order, deduped on normalized form
 *   - emails:     union (same dedupe rule)
 *   - phones:     union (same dedupe rule)
 *   - channels:   union; a channel key claimed by BOTH contacts with
 *                 different handles is a CONFLICT
 *   - primaryEmail: the most-recently-seen VERIFIED email address. Ties
 *                 (two verified emails with equal seenAt) are a CONFLICT.
 *                 No verified email → primaryEmail is null (explicit, not a
 *                 fallback guess).
 *
 * Merge-plan states:
 *   proposed → approved → merged
 *   Side states: rejected, conflict
 * A plan lands in `conflict` when field resolution hits a collision; the
 * collision must be resolved explicitly via resolveConflict(planId, field,
 * choice) before the plan can return to `proposed`. dryRun() previews the
 * merged record without mutating anything and throws CM_MERGE_CONFLICT while
 * any collision is unresolved.
 *
 * Dependency injection (all via the `deps` parameter of createContactMerge):
 *   - clock:   () => number  (ms epoch; default: Date.now)
 *   - id:      () => string  (id generator for contacts/plans/merges;
 *                             default: per-planner counters)
 *   - weights: { emailMatch, phoneMatch, nameChannelMatch, threshold }
 *              (all non-negative numbers; defaults: 1.0, 1.0, 0.6, 0.5)
 *
 * Nothing here touches the network, the DOM, localStorage, or any secret —
 * it is a pure planner. Every failure throws an Error with a `code` property:
 *   CM_INVALID_CONTACT    — contact shape invalid / duplicate id / self-merge
 *   CM_NOT_FOUND          — unknown contact id or plan id
 *   CM_INVALID_WEIGHTS    — weights not non-negative numbers
 *   CM_INVALID_TRANSITION — operation not allowed from the current state
 *                           (incl. below-threshold pair, already merged,
 *                           retired contact)
 *   CM_DUPLICATE_PROPOSAL — an active plan already exists for this pair
 *   CM_MERGE_CONFLICT     — unresolved field collision (dryRun/execute/approve
 *                           blocked until resolveConflict picks a choice)
 *   CM_INVALID_RESOLUTION — resolveConflict choice is not one of the options
 * Failures are never silent.
 */

export const MERGE_STATES = Object.freeze([
  'proposed',
  'approved',
  'merged',
  'rejected',
  'conflict',
]);

export const DEFAULT_WEIGHTS = Object.freeze({
  emailMatch: 1.0,
  phoneMatch: 1.0,
  nameChannelMatch: 0.6,
  threshold: 0.5,
});

const ACTIVE_PLAN_STATES = new Set(['proposed', 'approved', 'conflict']);

/** Throw a coded planner error (never silent failures). */
function cmError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/* ------------------------------------------------------------------ */
/* normalization                                                       */
/* ------------------------------------------------------------------ */

/** Lowercase + trim. */
function normEmail(value) {
  return String(value).trim().toLowerCase();
}

/** Digits only: '+1 (415) 555-0100' → '14155550100'. */
function normPhone(value) {
  return String(value).replace(/\D+/g, '');
}

/**
 * Case-folded, whitespace-collapsed, diacritics-stripped name so
 * 'José  García' and 'jose garcia' compare equal.
 */
function normName(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normChannelKey(key) {
  return String(key).trim().toLowerCase();
}

function normHandle(handle) {
  return String(handle).trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* contact validation / normalization                                  */
/* ------------------------------------------------------------------ */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertStringArray(value, field, contactLabel) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0)) {
    throw cmError(
      'CM_INVALID_CONTACT',
      `Contact ${contactLabel}: '${field}' must be an array of non-empty strings`,
      { field },
    );
  }
}

/**
 * Normalize one stored email entry. Accepts a string shorthand (unverified,
 * seen at `now`) or { address, verified?, seenAt? }.
 */
function normalizeEmailEntry(entry, now, contactLabel) {
  if (typeof entry === 'string') {
    if (entry.trim().length === 0) {
      throw cmError('CM_INVALID_CONTACT', `Contact ${contactLabel}: empty email string`, {});
    }
    return { address: entry.trim(), verified: false, seenAt: now };
  }
  if (!isPlainObject(entry) || typeof entry.address !== 'string' || entry.address.trim().length === 0) {
    throw cmError('CM_INVALID_CONTACT', `Contact ${contactLabel}: email entries need an address`, {});
  }
  const verified = entry.verified ?? false;
  const seenAt = entry.seenAt ?? now;
  if (typeof verified !== 'boolean' || typeof seenAt !== 'number' || !Number.isFinite(seenAt)) {
    throw cmError('CM_INVALID_CONTACT', `Contact ${contactLabel}: bad email verified/seenAt`, {});
  }
  return { address: entry.address.trim(), verified, seenAt };
}

function normalizePhoneEntry(entry, now, contactLabel) {
  if (typeof entry === 'string') {
    if (normPhone(entry).length === 0) {
      throw cmError('CM_INVALID_CONTACT', `Contact ${contactLabel}: empty phone string`, {});
    }
    return { number: entry.trim(), seenAt: now };
  }
  if (!isPlainObject(entry) || typeof entry.number !== 'string' || normPhone(entry.number).length === 0) {
    throw cmError('CM_INVALID_CONTACT', `Contact ${contactLabel}: phone entries need a number`, {});
  }
  const seenAt = entry.seenAt ?? now;
  if (typeof seenAt !== 'number' || !Number.isFinite(seenAt)) {
    throw cmError('CM_INVALID_CONTACT', `Contact ${contactLabel}: bad phone seenAt`, {});
  }
  return { number: entry.number.trim(), seenAt };
}

function normalizeChannels(channels, contactLabel) {
  if (!isPlainObject(channels)) {
    throw cmError('CM_INVALID_CONTACT', `Contact ${contactLabel}: 'channels' must be an object`, {});
  }
  const out = {};
  for (const [key, handle] of Object.entries(channels)) {
    if (typeof handle !== 'string' || handle.trim().length === 0) {
      throw cmError('CM_INVALID_CONTACT', `Contact ${contactLabel}: bad handle for channel '${key}'`, {});
    }
    out[key] = handle.trim();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* deterministic union helpers                                         */
/* ------------------------------------------------------------------ */

/** Union of string lists, first-seen order, deduped on norm(). */
function unionStrings(a, b, norm) {
  const seen = new Set();
  const out = [];
  for (const v of [...a, ...b]) {
    const k = norm(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

/** Union of entry lists ({address}|{number} payloads), deduped on norm(key). */
function unionEntries(a, b, keyOf, norm) {
  const seen = new Set();
  const out = [];
  for (const e of [...a, ...b]) {
    const k = norm(keyOf(e));
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* planner                                                             */
/* ------------------------------------------------------------------ */

/**
 * Create a new contact identity-resolution + merge planner.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{emailMatch:number, phoneMatch:number, nameChannelMatch:number, threshold:number}} [deps.weights]
 */
export function createContactMerge(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());

  let idCounter = 0;
  const newId = deps.id ?? (() => `cm-${(idCounter += 1)}`);

  const weights = validateWeights(deps.weights ?? {});

  /** Stored contacts, keyed by id. */
  const contacts = new Map();
  /** Merge plans, keyed by id. */
  const plans = new Map();
  /** Append-only audit log: every mutation lands here, never removed. */
  const audit = [];

  function validateWeights(w) {
    const merged = { ...DEFAULT_WEIGHTS, ...w };
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw cmError('CM_INVALID_WEIGHTS', `Weight '${key}' must be a non-negative finite number`, {
          key,
          value,
        });
      }
    }
    return Object.freeze(merged);
  }

  function record({ at, op, actor, detail }) {
    const entry = Object.freeze({
      at,
      op,
      actor,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  /* ---------------- contacts ---------------- */

  function snapshotContact(c) {
    return Object.freeze({
      id: c.id,
      names: Object.freeze([...c.names]),
      emails: Object.freeze(c.emails.map((e) => Object.freeze({ ...e }))),
      phones: Object.freeze(c.phones.map((p) => Object.freeze({ ...p }))),
      channels: Object.freeze({ ...c.channels }),
      primaryEmail: c.primaryEmail ?? null,
      mergedFrom: c.mergedFrom ? Object.freeze([...c.mergedFrom]) : null,
      mergedAt: c.mergedAt ?? null,
      status: c.status,
      mergedInto: c.mergedInto,
    });
  }

  function getContactOrThrow(id) {
    const c = contacts.get(id);
    if (!c) {
      throw cmError('CM_NOT_FOUND', `Unknown contact id: ${id}`, { contactId: id });
    }
    return c;
  }

  function assertActive(c, op) {
    if (c.status !== 'active') {
      throw cmError(
        'CM_INVALID_TRANSITION',
        `Cannot ${op}: contact ${c.id} is retired (merged into ${c.mergedInto})`,
        { contactId: c.id, mergedInto: c.mergedInto, op },
      );
    }
  }

  /* ---------------- scoring ---------------- */

  function emailSet(c) {
    return new Set(c.emails.map((e) => normEmail(e.address)));
  }

  function phoneSet(c) {
    return new Set(c.phones.map((p) => normPhone(p.number)).filter((n) => n.length > 0));
  }

  function nameSet(c) {
    return new Set(c.names.map(normName).filter((n) => n.length > 0));
  }

  function channelMap(c) {
    const m = new Map();
    for (const [key, handle] of Object.entries(c.channels)) {
      m.set(normChannelKey(key), normHandle(handle));
    }
    return m;
  }

  /**
   * Score one pair. Returns { score, links } where links describe each
   * contributing signal (kind, value, weight) in deterministic order.
   */
  function scorePair(a, b) {
    const links = [];
    let score = 0;

    const aEmails = emailSet(a);
    for (const e of emailSet(b)) {
      if (aEmails.has(e)) {
        links.push({ kind: 'email', value: e, weight: weights.emailMatch });
        score += weights.emailMatch;
      }
    }

    const aPhones = phoneSet(a);
    for (const p of phoneSet(b)) {
      if (aPhones.has(p)) {
        links.push({ kind: 'phone', value: p, weight: weights.phoneMatch });
        score += weights.phoneMatch;
      }
    }

    const aNames = nameSet(a);
    const sharedName = [...nameSet(b)].some((n) => aNames.has(n));
    if (sharedName) {
      const aChannels = channelMap(a);
      const shared = [];
      for (const [key, handle] of channelMap(b)) {
        if (aChannels.get(key) === handle) shared.push({ key, handle });
      }
      shared.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
      for (const { key, handle } of shared) {
        links.push({
          kind: 'name+channel',
          value: `${key}:${handle}`,
          weight: weights.nameChannelMatch,
        });
        score += weights.nameChannelMatch;
      }
    }

    links.sort((x, y) =>
      x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.value < y.value ? -1 : x.value > y.value ? 1 : 0,
    );
    return { score, links: links.map((l) => Object.freeze({ ...l })) };
  }

  /* ---------------- field resolution ---------------- */

  /**
   * Build the deterministic field-resolution plan for pair (a, b) with a.id
   * first (callers canonicalize order). Returns { fieldPlan, conflicts }.
   * conflicts: [{ field, options: string[], reason }] — each needs an
   * explicit choice via resolveConflict before the plan can be approved.
   */
  function buildFieldPlan(a, b, resolutions) {
    const conflicts = [];

    const names = unionStrings(a.names, b.names, normName);
    const emails = unionEntries(a.emails, b.emails, (e) => e.address, normEmail);
    const phones = unionEntries(a.phones, b.phones, (p) => p.number, normPhone);

    // channels union — same key, different handle = conflict
    const channels = { ...a.channels };
    const channelConflicts = [];
    for (const [key, handleB] of Object.entries(b.channels)) {
      if (!(key in channels)) {
        channels[key] = handleB;
        continue;
      }
      if (normHandle(channels[key]) !== normHandle(handleB)) {
        channelConflicts.push({ key, a: channels[key], b: handleB });
      }
    }

    // primaryEmail: most-recently-seen verified; exact seenAt ties = conflict
    const verified = emails
      .filter((e) => e.verified)
      .sort((x, y) => y.seenAt - x.seenAt || (x.address < y.address ? -1 : 1));
    let primaryEmail = null;
    let primaryConflict = null;
    if (verified.length > 0) {
      const top = verified.filter((e) => e.seenAt === verified[0].seenAt);
      const addresses = [...new Set(top.map((e) => e.address))].sort();
      if (addresses.length === 1) {
        primaryEmail = addresses[0];
      } else {
        primaryConflict = {
          field: 'primaryEmail',
          options: addresses,
          reason: 'tied most-recently-seen verified emails',
        };
      }
    }

    const fieldPlan = {
      names: { strategy: 'union', value: names },
      emails: { strategy: 'union', value: emails },
      phones: { strategy: 'union', value: phones },
      channels: { strategy: 'union', value: channels },
      primaryEmail: { strategy: 'most-recently-seen-verified', value: primaryEmail },
    };

    for (const { key, a: ha, b: hb } of channelConflicts) {
      conflicts.push({
        field: `channels.${key}`,
        options: [ha, hb],
        reason: `channel '${key}' has different handles in the two contacts`,
      });
    }
    if (primaryConflict) conflicts.push(primaryConflict);

    // Apply any explicit resolutions already recorded on the plan.
    for (const [field, choice] of Object.entries(resolutions)) {
      applyResolution(fieldPlan, field, choice);
    }

    const unresolved = conflicts.filter((c) => !(c.field in resolutions));
    return { fieldPlan, conflicts, unresolved };
  }

  function applyResolution(fieldPlan, field, choice) {
    if (field === 'primaryEmail') {
      fieldPlan.primaryEmail = {
        strategy: 'explicit-choice',
        value: choice,
      };
      return;
    }
    if (field.startsWith('channels.')) {
      const key = field.slice('channels.'.length);
      fieldPlan.channels = {
        strategy: 'explicit-choice',
        value: { ...fieldPlan.channels.value, [key]: choice },
      };
      return;
    }
    throw cmError('CM_INVALID_RESOLUTION', `Unknown conflict field: ${field}`, { field });
  }

  /** Assemble the merged-record preview from a fully-resolved field plan. */
  function assemblePreview(plan) {
    const fp = plan.fieldPlan;
    return {
      id: plan.mergedId,
      names: [...fp.names.value],
      emails: fp.emails.value.map((e) => ({ ...e })),
      phones: fp.phones.value.map((p) => ({ ...p })),
      channels: { ...fp.channels.value },
      primaryEmail: fp.primaryEmail.value,
      mergedFrom: [plan.contactA, plan.contactB],
      mergedAt: plan.mergedAt,
    };
  }

  /* ---------------- plans ---------------- */

  function snapshotPlan(plan) {
    const fp = plan.fieldPlan;
    return Object.freeze({
      id: plan.id,
      state: plan.state,
      contactA: plan.contactA,
      contactB: plan.contactB,
      score: plan.score,
      links: Object.freeze(plan.links.map((l) => Object.freeze({ ...l }))),
      fieldPlan: Object.freeze({
        names: Object.freeze({ strategy: fp.names.strategy, value: Object.freeze([...fp.names.value]) }),
        emails: Object.freeze({
          strategy: fp.emails.strategy,
          value: Object.freeze(fp.emails.value.map((e) => Object.freeze({ ...e }))),
        }),
        phones: Object.freeze({
          strategy: fp.phones.strategy,
          value: Object.freeze(fp.phones.value.map((p) => Object.freeze({ ...p }))),
        }),
        channels: Object.freeze({ strategy: fp.channels.strategy, value: Object.freeze({ ...fp.channels.value }) }),
        primaryEmail: Object.freeze({ ...fp.primaryEmail }),
      }),
      conflicts: Object.freeze(plan.conflicts.map((c) => Object.freeze({ ...c, options: [...c.options] }))),
      resolutions: Object.freeze({ ...plan.resolutions }),
      rejectReason: plan.rejectReason,
      mergedId: plan.mergedId,
      mergedAt: plan.mergedAt,
    });
  }

  function getPlanOrThrow(id) {
    const plan = plans.get(id);
    if (!plan) {
      throw cmError('CM_NOT_FOUND', `Unknown merge plan id: ${id}`, { planId: id });
    }
    return plan;
  }

  function assertPlanState(plan, allowed, op) {
    if (!allowed.includes(plan.state)) {
      throw cmError(
        'CM_INVALID_TRANSITION',
        `Cannot ${op} plan ${plan.id} from state '${plan.state}'`,
        { planId: plan.id, state: plan.state, op },
      );
    }
  }

  function transition(plan, to, actor, detail) {
    const from = plan.state;
    plan.state = to;
    record({
      at: clock(),
      op: 'plan-transition',
      actor,
      detail: { planId: plan.id, from, to, ...(detail ?? {}) },
    });
    return snapshotPlan(plan);
  }

  /** Canonical pair key: lower id first — proposeMerge(a,b) ≡ proposeMerge(b,a). */
  function pairKey(idA, idB) {
    return [idA, idB].sort().join('␟');
  }

  const planner = {
    /** Configured similarity weights (frozen). */
    get weights() {
      return weights;
    },

    /** Append-only audit trail: {at, op, actor, detail}. */
    get audit() {
      return [...audit];
    },

    /**
     * Add a contact. Accepts shorthand (string emails/phones, missing id).
     * Returns a frozen snapshot of the stored record.
     */
    addContact(input, actor = 'agent') {
      const label = input?.id ?? '<no-id>';
      if (!isPlainObject(input)) {
        throw cmError('CM_INVALID_CONTACT', 'Contact must be an object', {});
      }
      const id = input.id ?? newId();
      if (typeof id !== 'string' || id.length === 0) {
        throw cmError('CM_INVALID_CONTACT', 'Contact id must be a non-empty string', {});
      }
      if (contacts.has(id)) {
        throw cmError('CM_INVALID_CONTACT', `Duplicate contact id: ${id}`, { contactId: id });
      }
      const names = input.names ?? [];
      const emailsIn = input.emails ?? [];
      const phonesIn = input.phones ?? [];
      const channelsIn = input.channels ?? {};
      assertStringArray(names, 'names', label);
      if (!Array.isArray(emailsIn)) {
        throw cmError('CM_INVALID_CONTACT', `Contact ${label}: 'emails' must be an array`, {});
      }
      if (!Array.isArray(phonesIn)) {
        throw cmError('CM_INVALID_CONTACT', `Contact ${label}: 'phones' must be an array`, {});
      }
      const now = clock();
      const contact = {
        id,
        names: [...names],
        emails: emailsIn.map((e) => normalizeEmailEntry(e, now, label)),
        phones: phonesIn.map((p) => normalizePhoneEntry(p, now, label)),
        channels: normalizeChannels(channelsIn, label),
        primaryEmail: null,
        mergedFrom: null,
        mergedAt: null,
        status: 'active',
        mergedInto: null,
      };
      contacts.set(id, contact);
      record({ at: now, op: 'add-contact', actor, detail: { contactId: id } });
      return snapshotContact(contact);
    },

    /** Read-only snapshot of a contact (null if unknown). */
    getContact(id) {
      const c = contacts.get(id);
      return c ? snapshotContact(c) : null;
    },

    /**
     * Score every active pair and surface candidates at or above threshold.
     * Returns frozen [{ candidateId, contactA, contactB, score, links }].
     */
    findCandidates() {
      const active = [...contacts.values()].filter((c) => c.status === 'active');
      const out = [];
      for (let i = 0; i < active.length; i += 1) {
        for (let j = i + 1; j < active.length; j += 1) {
          const a = active[i];
          const b = active[j];
          const { score, links } = scorePair(a, b);
          if (score >= weights.threshold && links.length > 0) {
            const [first, second] = [a.id, b.id].sort();
            out.push(
              Object.freeze({
                candidateId: `cand-${first}--${second}`,
                contactA: first,
                contactB: second,
                score,
                links: Object.freeze(links),
              }),
            );
          }
        }
      }
      return out;
    },

    /**
     * Create a merge plan for a pair. Pair order is canonicalized so
     * proposeMerge(a, b) ≡ proposeMerge(b, a). Plans start in `proposed`,
     * or `conflict` when field resolution hits a collision. Throws
     * CM_DUPLICATE_PROPOSAL if an active plan already covers the pair.
     */
    proposeMerge(idA, idB, actor = 'agent') {
      if (idA === idB) {
        throw cmError('CM_INVALID_TRANSITION', 'Cannot merge a contact with itself', {
          contactId: idA,
        });
      }
      const first = getContactOrThrow(idA);
      const second = getContactOrThrow(idB);
      assertActive(first, 'propose merge for');
      assertActive(second, 'propose merge for');

      const key = pairKey(idA, idB);
      for (const plan of plans.values()) {
        if (ACTIVE_PLAN_STATES.has(plan.state) && plan.pairKey === key) {
          throw cmError('CM_DUPLICATE_PROPOSAL', `Active plan ${plan.id} already covers this pair`, {
            planId: plan.id,
            contactA: plan.contactA,
            contactB: plan.contactB,
          });
        }
      }

      const [a, b] = [first, second].sort((x, y) => (x.id < y.id ? -1 : 1));
      const { score, links } = scorePair(a, b);
      if (score < weights.threshold || links.length === 0) {
        throw cmError(
          'CM_INVALID_TRANSITION',
          `Pair ${a.id}/${b.id} scores ${score} — below threshold ${weights.threshold}; no merge proposal`,
          { contactA: a.id, contactB: b.id, score, threshold: weights.threshold },
        );
      }

      const id = newId();
      const mergedId = newId();
      const mergedAt = clock();
      const plan = {
        id,
        pairKey: key,
        state: 'proposed',
        contactA: a.id,
        contactB: b.id,
        score,
        links,
        fieldPlan: null,
        conflicts: [],
        resolutions: {},
        rejectReason: null,
        mergedId,
        mergedAt,
      };
      const built = buildFieldPlan(a, b, plan.resolutions);
      plan.fieldPlan = built.fieldPlan;
      plan.conflicts = built.conflicts;
      plans.set(id, plan);
      record({
        at: mergedAt,
        op: 'propose-merge',
        actor,
        detail: { planId: id, contactA: a.id, contactB: b.id, score },
      });

      if (built.unresolved.length > 0) {
        return transition(plan, 'conflict', 'system', {
          reason: 'field collision requires explicit resolution',
          conflicts: built.unresolved.map((c) => c.field),
        });
      }
      return snapshotPlan(plan);
    },

    /**
     * Resolve one field collision with an explicit choice. The choice must be
     * one of the conflict's options. Returns the plan to `proposed` once all
     * collisions are resolved (stays in `conflict` while any remain).
     */
    resolveConflict(planId, field, choice, actor = 'agent') {
      const plan = getPlanOrThrow(planId);
      assertPlanState(plan, ['conflict'], 'resolve conflict for');
      const conflict = plan.conflicts.find((c) => c.field === field);
      if (!conflict) {
        throw cmError('CM_INVALID_RESOLUTION', `Plan ${planId} has no conflict on field '${field}'`, {
          planId,
          field,
        });
      }
      if (!conflict.options.includes(choice)) {
        throw cmError(
          'CM_INVALID_RESOLUTION',
          `Choice for '${field}' must be one of [${conflict.options.join(', ')}]`,
          { planId, field, choice, options: conflict.options },
        );
      }
      plan.resolutions[field] = choice;
      const a = getContactOrThrow(plan.contactA);
      const b = getContactOrThrow(plan.contactB);
      const built = buildFieldPlan(a, b, plan.resolutions);
      plan.fieldPlan = built.fieldPlan;
      plan.conflicts = built.conflicts;
      record({
        at: clock(),
        op: 'resolve-conflict',
        actor,
        detail: { planId, field, choice },
      });
      if (built.unresolved.length === 0) {
        return transition(plan, 'proposed', actor, { resolved: field });
      }
      return snapshotPlan(plan);
    },

    /**
     * Pure dry run: preview the merged record WITHOUT changing plan state,
     * contacts, or the audit log. Throws CM_MERGE_CONFLICT while any field
     * collision is unresolved.
     */
    dryRun(planId) {
      const plan = getPlanOrThrow(planId);
      if (plan.state === 'conflict' || plan.conflicts.some((c) => !(c.field in plan.resolutions))) {
        const fields = plan.conflicts.filter((c) => !(c.field in plan.resolutions)).map((c) => c.field);
        throw cmError(
          'CM_MERGE_CONFLICT',
          `Plan ${planId} has unresolved field collisions: ${fields.join(', ')}`,
          { planId, fields },
        );
      }
      assertPlanState(plan, ['proposed', 'approved', 'merged'], 'dry-run');
      return Object.freeze(assemblePreview(plan));
    },

    /** Move a fully-resolved plan proposed → approved. */
    approve(planId, actor = 'john') {
      const plan = getPlanOrThrow(planId);
      assertPlanState(plan, ['proposed'], 'approve');
      if (plan.conflicts.some((c) => !(c.field in plan.resolutions))) {
        // Unreachable via the public API (conflicts force `conflict` state),
        // but approval must never cover an unresolved collision.
        transition(plan, 'conflict', actor, { reason: 'unresolved collision at approval time' });
        throw cmError(
          'CM_MERGE_CONFLICT',
          `Plan ${planId} cannot be approved with unresolved field collisions`,
          { planId },
        );
      }
      return transition(plan, 'approved', actor, {});
    },

    /** Reject a plan from proposed or conflict. Terminal. */
    reject(planId, reason, actor = 'john') {
      const plan = getPlanOrThrow(planId);
      assertPlanState(plan, ['proposed', 'conflict'], 'reject');
      plan.rejectReason = reason ?? '';
      return transition(plan, 'rejected', actor, { reason: plan.rejectReason });
    },

    /**
     * Execute an approved plan: retire both source contacts (status `merged`,
     * mergedInto set) and return the merged record snapshot. The merge is
     * exactly the dryRun preview — execute() reuses the same assembly.
     */
    execute(planId, actor = 'agent') {
      const plan = getPlanOrThrow(planId);
      assertPlanState(plan, ['approved'], 'execute');
      if (plan.conflicts.some((c) => !(c.field in plan.resolutions))) {
        throw cmError(
          'CM_MERGE_CONFLICT',
          `Plan ${planId} cannot be executed with unresolved field collisions`,
          { planId },
        );
      }
      const preview = assemblePreview(plan);
      const a = getContactOrThrow(plan.contactA);
      const b = getContactOrThrow(plan.contactB);
      assertActive(a, 'execute merge for');
      assertActive(b, 'execute merge for');
      const now = clock();
      const merged = {
        id: preview.id,
        names: preview.names,
        emails: preview.emails,
        phones: preview.phones,
        channels: preview.channels,
        primaryEmail: preview.primaryEmail,
        mergedFrom: preview.mergedFrom,
        mergedAt: preview.mergedAt,
        status: 'active',
        mergedInto: null,
      };
      contacts.set(merged.id, merged);
      for (const c of [a, b]) {
        c.status = 'merged';
        c.mergedInto = merged.id;
      }
      record({
        at: now,
        op: 'execute-merge',
        actor,
        detail: { planId, mergedId: merged.id, contactA: plan.contactA, contactB: plan.contactB },
      });
      transition(plan, 'merged', actor, { mergedId: merged.id });
      return snapshotContact(merged);
    },

    /** Read-only snapshot of a plan (null if unknown). */
    getPlan(id) {
      const plan = plans.get(id);
      return plan ? snapshotPlan(plan) : null;
    },
  };

  return Object.freeze(planner);
}
