// Dashboard honesty pass (strategy-rethink opps #24, #27, #28).
//
// Additive and reversible: this module never changes an existing metric
// shape. It adds three things the room's analytics baseline lacked:
//
//  1. falsifierRows — the key falsifiable claims from the strategy doc's
//     assumption audit, as visible rows with current values. Falsifiers
//     the room cannot measure yet are published as rows with value null
//     and status "unmeasured" — nothing measured stays private, and
//     nothing unmeasured is faked.
//  2. laneActivitySplit — agent activity split into John-subsidized lane
//     activity ("testing") vs organic agent activity. Lane membership is
//     configured, never guessed: with no lane ids configured the split
//     reports unconfigured instead of mislabeling.
//  3. nonJohnFundedSettledPerWeek — the demand-side headline metric from
//     opp #28, alongside (not replacing) the existing metrics. There is
//     no USD settlement rail yet, so the USD value is honestly null and
//     the credit-denominated proxy is reported beside it.
//
// All functions are pure over their inputs; outputs are frozen. The
// bounty-journal reads are guarded by tableExists so the module degrades
// on databases without escrow tables.
import { isoWeekStart } from "./metrics.mjs";
import { tableExists } from "./schema.mjs";

const DAY = 86400000;
const WEEK = 7 * DAY;
const STALL_AFTER_MS = 14 * DAY;

// Mirrors the ACTIVITY set in server/analytics/metrics.mjs (kept local so
// this module never edits metrics.mjs). Count the same activity events so
// the lane split is comparable with weeklyProductiveRooms.
const ACTIVITY = new Set([
  "room_created", "invite_accepted", "agent_first_post",
  "claim_created", "claim_claimed", "pr_linked", "pr_merged", "claim_completed", "receipt_issued"
]);

const BOND_LOCK = "bond-lock";
const BOND_FORFEIT = "bond-forfeit";

function parseIdList(value) {
  if (typeof value !== "string") return new Set();
  return new Set(value.split(",").map(part => part.trim()).filter(Boolean));
}

export function laneActorIdsFromEnv(env = process.env) {
  return parseIdList(env?.ANALYTICS_LANE_ACTOR_IDS);
}

export function johnActorIdsFromEnv(env = process.env) {
  return parseIdList(env?.ANALYTICS_JOHN_ACTOR_IDS);
}

function normalizeEvent(row) {
  const props = typeof row.props === "string" ? JSON.parse(row.props) : (row.props ?? {});
  return {
    name: row.name,
    at: row.at,
    roomId: row.room_id ?? row.roomId ?? null,
    actorKind: row.actor_kind ?? row.actorKind ?? null,
    actorId: row.actor_id ?? row.actorId ?? null,
    props
  };
}

function loadNormalizedEvents(db) {
  if (!tableExists(db, "analytics_events")) return [];
  return db.prepare("SELECT name, at, room_id, actor_kind, actor_id, props FROM analytics_events")
    .all()
    .map(normalizeEvent)
    .filter(event => Number.isFinite(event.at));
}

// Opp #27: label John-subsidized lane activity as testing, distinctly from
// organic agent activity. laneActorIds is a Set of actor ids known to be
// John's lanes; with it empty the split reports "unconfigured" and all
// agent activity stays in organicAgentActivity — never silently relabeled.
export function laneActivitySplit({ events, now = Date.now(), weeks = 12, laneActorIds = new Set() } = {}) {
  const end = isoWeekStart(now);
  const starts = [];
  for (let i = weeks - 1; i >= 0; i -= 1) starts.push(end - i * WEEK);
  const configured = laneActorIds instanceof Set && laneActorIds.size > 0;
  const buckets = new Map(starts.map(start => [start, { lane: 0, organicAgent: 0, human: 0 }]));
  for (const event of events ?? []) {
    if (!ACTIVITY.has(event.name) || !Number.isFinite(event.at)) continue;
    const start = isoWeekStart(event.at);
    const bucket = buckets.get(start);
    if (!bucket) continue;
    if (event.actorKind === "human") {
      bucket.human += event.weight ?? 1;
    } else if (event.actorKind === "agent") {
      if (configured && event.actorId != null && laneActorIds.has(event.actorId)) {
        bucket.lane += event.weight ?? 1;
      } else {
        bucket.organicAgent += event.weight ?? 1;
      }
    }
  }
  const attribution = configured ? "configured" : "unconfigured";
  return Object.freeze(starts.map(start => {
    const bucket = buckets.get(start);
    const agentTotal = bucket.lane + bucket.organicAgent;
    return Object.freeze({
      week: new Date(start).toISOString().slice(0, 10),
      // #27: lane activity is testing, labeled as such.
      laneActivityTesting: bucket.lane,
      organicAgentActivity: bucket.organicAgent,
      humanActivity: bucket.human,
      laneShareOfAgentActivity: agentTotal === 0 ? null : Math.round((bucket.lane / agentTotal) * 1000) / 10,
      laneAttribution: attribution
    });
  }));
}

function journalAtMs(at) {
  if (typeof at === "number") return at;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : null;
}

// Opp #28: "non-John-funded USD settled/week" alongside existing metrics.
// There is no USD settlement rail in the room yet (escrow settles credits),
// so usdCents is honestly null; the credit proxy is reported beside it.
// John-funded = the bounty's poster is in johnActorIds; rows whose poster
// cannot be attributed land in unattributedMillis, never in either side.
export function nonJohnFundedSettledPerWeek({ db, now = Date.now(), weeks = 12, johnActorIds = new Set() } = {}) {
  const end = isoWeekStart(now);
  const starts = [];
  for (let i = weeks - 1; i >= 0; i -= 1) starts.push(end - i * WEEK);
  const cutoff = starts[0];
  const buckets = new Map(starts.map(start => [start, { total: 0, john: 0, unattributed: 0 }]));
  const hasJournal = tableExists(db, "bounty_journal");
  const hasRecords = tableExists(db, "bounty_records");
  const configured = johnActorIds instanceof Set && johnActorIds.size > 0;
  if (hasJournal) {
    const rows = hasRecords
      ? db.prepare(`SELECT j.at AS at, j.amount AS amount, r.poster AS poster
          FROM bounty_journal j LEFT JOIN bounty_records r ON r.bounty_id = j.bounty_id
          WHERE j.kind = 'payout' AND j.amount > 0`).all()
      : db.prepare(`SELECT at, amount FROM bounty_journal WHERE kind = 'payout' AND amount > 0`).all();
    for (const row of rows) {
      const at = journalAtMs(row.at);
      if (at == null || at < cutoff) continue;
      const start = isoWeekStart(at);
      const bucket = buckets.get(start);
      if (!bucket) continue;
      const amount = Number(row.amount) || 0;
      bucket.total += amount;
      if (row.poster == null) {
        bucket.unattributed += amount;
      } else if (configured && johnActorIds.has(row.poster)) {
        bucket.john += amount;
      } else if (configured) {
        // non-John-funded: attributed below via total - john - unattributed
      } else {
        bucket.unattributed += amount;
      }
    }
  }
  return Object.freeze(starts.map(start => {
    const bucket = buckets.get(start);
    return Object.freeze({
      week: new Date(start).toISOString().slice(0, 10),
      // The headline metric. Null until a USD rail exists — never faked.
      nonJohnFundedUsdCents: null,
      usdStatus: "unmeasured",
      usdNote: "no USD settlement rail yet; escrow settles credits",
      // Credit-denominated proxy, honestly labeled.
      nonJohnFundedCreditsMillis: configured ? bucket.total - bucket.john - bucket.unattributed : null,
      totalCreditsMillis: bucket.total,
      johnFundedCreditsMillis: configured ? bucket.john : null,
      unattributedCreditsMillis: bucket.unattributed,
      johnAttribution: configured ? "configured" : "unconfigured",
      unit: "credits"
    });
  }));
}

// Opp #24: the assumption audit's falsifiers as dashboard rows. Measured
// where the room's own data supports it; unmeasured (value null) where it
// doesn't — published anyway, never hidden, never fabricated.
export function falsifierRows({ db, events = [], now = Date.now(), laneActorIds = new Set(), johnActorIds = new Set() } = {}) {
  const split = laneActivitySplit({ events, now, weeks: 12, laneActorIds });
  const settled = nonJohnFundedSettledPerWeek({ db, now, weeks: 12, johnActorIds });
  const laneShares = split.map(row => row.laneShareOfAgentActivity).filter(value => value != null);
  const latestLaneShare = laneShares.length ? laneShares[laneShares.length - 1] : null;
  const signups = events.filter(event => event.name === "signup" && Number.isFinite(event.at) && event.at >= now - 28 * DAY).length;

  let bondLocks = 0;
  let bondForfeits = 0;
  if (tableExists(db, "bounty_journal")) {
    bondLocks = db.prepare("SELECT count(*) AS n FROM bounty_journal WHERE kind = ?").get(BOND_LOCK)?.n ?? 0;
    bondForfeits = db.prepare("SELECT count(*) AS n FROM bounty_journal WHERE kind = ?").get(BOND_FORFEIT)?.n ?? 0;
  }
  let stalledFunded = null;
  let fundedTotal = null;
  if (tableExists(db, "bounty_records")) {
    fundedTotal = db.prepare("SELECT count(*) AS n FROM bounty_records WHERE state = 'funded'").get()?.n ?? 0;
    stalledFunded = db.prepare("SELECT count(*) AS n FROM bounty_records WHERE state = 'funded' AND state_changed_ms < ?")
      .get(now - STALL_AFTER_MS)?.n ?? 0;
  }

  const rows = [
    {
      id: "lane_share_of_traction",
      assumption: "C5 — the lanes will run it",
      claim: "Lane activity is distribution",
      falsifier: ">90% of flow still lanes/John-funded at 6 months",
      value: latestLaneShare,
      unit: "percent of agent activity, latest week",
      status: laneActorIds.size > 0 ? "measured" : "unconfigured",
      note: laneActorIds.size > 0
        ? "Lane activity is testing, not traction (opp #27)."
        : "Set ANALYTICS_LANE_ACTOR_IDS to measure; until then the lane share is unknown, not zero."
    },
    {
      id: "non_john_funded_usd_settled_per_week",
      assumption: "C6 — agents earning/week is the binding metric",
      claim: "Supply-side activity is the number to optimize",
      falsifier: "metric grows, revenue doesn't",
      value: null,
      unit: "USD/week",
      status: "unmeasured",
      note: "No USD settlement rail yet. Credit proxy, latest week: " +
        `${settled[settled.length - 1]?.nonJohnFundedCreditsMillis ?? "unattributed"} millis credits non-John-funded.`
    },
    {
      id: "bond_step_churn",
      assumption: "A2 — bonds ship before payouts",
      claim: "Bonds don't deter workers",
      falsifier: "workers churn at the bond step",
      value: bondLocks === 0 ? null : Math.round((bondForfeits / bondLocks) * 1000) / 10,
      unit: "percent of bond-locks forfeited, all time",
      status: bondLocks === 0 ? "unmeasured" : "measured",
      note: `locks=${bondLocks} forfeits=${bondForfeits}`
    },
    {
      id: "bounty_stall_funded",
      assumption: "B3 — escrowed bounty lifecycle is the money primitive",
      claim: "Escrowed bounties clear",
      falsifier: "bounties stall in funded awaiting evaluators/workers",
      value: stalledFunded,
      unit: "bounties in funded >14d (of funded total)",
      status: stalledFunded == null ? "unmeasured" : "measured",
      note: stalledFunded == null ? "bounty_records table absent" : `funded total=${fundedTotal}`
    },
    {
      id: "onboarding_arrivals",
      assumption: "C2 — 2-minute onboarding is the binding constraint",
      claim: "Onboarding fixes move arrivals",
      falsifier: "2-minute onboarding, arrivals unchanged",
      value: signups,
      unit: "signups, trailing 28 days",
      status: "measured",
      note: "Arrival volume; compare against the 28d window after any onboarding change."
    },
    {
      id: "proposals_to_room_conversion",
      assumption: "C1 — Upwork buyers convert to room users",
      claim: "The buyer list is a pipeline",
      falsifier: "15 proposals sent, zero buyers try the room",
      value: null,
      unit: "buyers active in room / proposals sent",
      status: "unmeasured",
      note: "Upwork data is external to the room DB; track per outreach round manually."
    },
    {
      id: "shipping_vs_external_metrics",
      assumption: "C3 — weekly visible shipping compounds",
      claim: "Shipping cadence moves external metrics",
      falsifier: "8 weeks shipping, zero external-metric movement",
      value: null,
      unit: "external metric delta / week shipped",
      status: "unmeasured",
      note: "External metrics (stranger signups, inbound) are not in the room DB."
    },
    {
      id: "content_published",
      assumption: "C4 — extract content from work already done",
      claim: "Content creation is the bottleneck",
      falsifier: "20 pieces ready, 0 published after a month",
      value: null,
      unit: "pieces published / pieces drafted",
      status: "unmeasured",
      note: "Publishing happens outside the room; count manually per week."
    },
    {
      id: "agent_activity_creates_demand",
      assumption: "A8 — per-claim micro-sinks absorb supply",
      claim: "Agent activity creates token demand",
      falsifier: "sinks flow but price/retention don't respond",
      value: null,
      unit: "retention response to sink flow",
      status: "unmeasured",
      note: "Needs token price/hold data; TAO evidence says expensive locks beat micro-sinks."
    }
  ];
  return Object.freeze(rows.map(row => Object.freeze({ ...row, measuredAt: new Date(now).toISOString() })));
}

// The dashboard section: falsifiers, lane-labeled activity, and the
// demand-side metric, composed for the operator baseline report.
export function dashboardHonestyReport({ db, now = Date.now(), env = process.env } = {}) {
  const events = loadNormalizedEvents(db);
  const laneActorIds = laneActorIdsFromEnv(env);
  const johnActorIds = johnActorIdsFromEnv(env);
  return Object.freeze({
    label: "dashboard honesty pass (opps #24/#27/#28); additive; unmeasured falsifiers shown, not hidden",
    laneActivity: laneActivitySplit({ events, now, laneActorIds }),
    settledPerWeek: nonJohnFundedSettledPerWeek({ db, now, johnActorIds }),
    falsifiers: falsifierRows({ db, events, now, laneActorIds, johnActorIds })
  });
}
