// Emissary slice 3 (IB-029) — ring-detection simulator (RC-2026-09-28-2905).
//
// A pure, fixture-driven library for spotting collusion-ring shapes in
// fund-flow graphs. It exists so the room can name the *shapes* it must
// defend against (spec §4.2/§4.3: self-referral farms, Sybil rings) before
// any live money or live identity data flows through them.
//
// What it is: graph-shape analysis over caller-supplied transfer edges.
// What it is NOT: an identity service, a money mover, or an accuser.
// Every node id it ever sees in tests starts with "SYNTH-"; the
// fixtures in tests/fixtures/wazz-rings.json are synthetic motifs shaped
// on the published Wazz forensic report, carrying NO real addresses,
// amounts, or identities (the report itself only published truncated
// prefixes; the watchlist honesty rule stands: addresses are evidence,
// never identities).
//
// Signals (each is weak evidence on its own):
//   cluster_link  — union-find entity clustering over shared attributes
//                   (payout address, inviter, device fingerprint)
//   fan_in        — many distinct sources -> one hub (collector shape)
//   fan_out       — one hub -> many distinct targets (distributor shape)
//   burst         — many transfers inside a short sliding window
//                   (synchrony / script-driven shape)
//   refund_loop   — a path that returns proceeds to a hub (circular flow)
//
// Multi-signal rule (the load-bearing invariant): a single signal never
// flags. A finding is emitted ONLY when >= 3 distinct signals co-occur on
// the same hub/entity-cluster. Everything else is written to the
// caller-owned exclusion journal as an excluded observation — findings
// only, never auto-punishment; enforcement decisions belong to the
// caller (owner/operator), never to this library.
//
// All state is caller-owned: `journal` is an array the caller passes in;
// this module never opens a socket, never touches a database, never
// persists anything.

const fail = (code, message, details) => {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  throw err;
};

// ---------------------------------------------------------------------------
// Input validation (fail closed)
// ---------------------------------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function assertGraph(graph) {
  if (!isPlainObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    fail("emissary_ring_bad_graph", "graph must be { nodes: [...], edges: [...] }");
  }
  for (const n of graph.nodes) {
    if (!isPlainObject(n) || typeof n.id !== "string" || n.id.length === 0) {
      fail("emissary_ring_bad_node", "every node needs a string id", { node: n });
    }
  }
  for (const e of graph.edges) {
    if (!isPlainObject(e) || typeof e.from !== "string" || typeof e.to !== "string") {
      fail("emissary_ring_bad_edge", "every edge needs string from/to", { edge: e });
    }
    if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) {
      fail("emissary_ring_bad_edge", "every edge needs a numeric epoch-ms ts", { edge: e });
    }
  }
  return graph;
}

// ---------------------------------------------------------------------------
// cluster_link — union-find over shared attributes
// ---------------------------------------------------------------------------

const CLUSTER_ATTRS = ["payout", "inviter", "device"];

function unionFind(nodes) {
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // path compression
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union };
}

/**
 * clusterEntities(nodes) -> [{ members: [...ids], via: [{ attr, value }] }]
 * Links nodes sharing any attribute value (payout / inviter / device).
 * Only clusters of size >= minSize (default 2) are returned.
 */
export function clusterEntities(nodes, { minSize = 2 } = {}) {
  if (!Array.isArray(nodes)) fail("emissary_ring_bad_nodes", "nodes must be an array");
  const uf = unionFind(nodes);
  const attrOwners = new Map(); // "attr:value" -> first owner id
  for (const node of nodes) {
    const attrs = isPlainObject(node.attributes) ? node.attributes : {};
    for (const attr of CLUSTER_ATTRS) {
      const value = attrs[attr];
      if (typeof value !== "string" || value.length === 0) continue;
      const key = `${attr}:${value}`;
      if (attrOwners.has(key)) {
        uf.union(node.id, attrOwners.get(key));
      } else {
        attrOwners.set(key, node.id);
      }
    }
  }
  const clusters = new Map();
  for (const node of nodes) {
    const root = uf.find(node.id);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root).add(node.id);
  }
  const out = [];
  for (const members of clusters.values()) {
    if (members.size < minSize) continue;
    const via = new Set();
    for (const id of members) {
      const node = nodes.find((n) => n.id === id);
      const attrs = isPlainObject(node?.attributes) ? node.attributes : {};
      for (const attr of CLUSTER_ATTRS) {
        const value = attrs[attr];
        if (typeof value !== "string" || value.length === 0) continue;
        via.add(`${attr}:${value}`);
      }
    }
    out.push({ members: [...members].sort(), via: [...via].sort() });
  }
  out.sort((a, b) => b.members.length - a.members.length || (a.members[0] < b.members[0] ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// fan_in / fan_out — hub detection
// ---------------------------------------------------------------------------

/**
 * detectFanIn(edges, { minSources, windowMs }) -> [{ hub, sources, edgeCount,
 *   firstTs, lastTs, withinWindow }]
 * A hub receiving from >= minSources distinct sources. When windowMs is set,
 * the sources must ALSO cluster inside a window that short (burst-shaped
 * collection, e.g. the 98-wallet / 3s collector motif).
 */
export function detectFanIn(edges, { minSources = 10, windowMs = null } = {}) {
  if (!Array.isArray(edges)) fail("emissary_ring_bad_edges", "edges must be an array");
  const byHub = new Map();
  for (const e of edges) {
    if (!byHub.has(e.to)) byHub.set(e.to, []);
    byHub.get(e.to).push(e);
  }
  const out = [];
  for (const [hub, list] of byHub) {
    const sources = new Set(list.map((e) => e.from));
    if (sources.size < minSources) continue;
    const byTs = [...list].sort((a, b) => a.ts - b.ts);
    let withinWindow = null;
    if (windowMs !== null) {
      // sliding check: some windowMs-wide window must hold >= minSources
      // distinct sources (a later re-seed edge must not void the burst
      // that already happened).
      withinWindow = false;
      let j = 0;
      for (let i = 0; i < byTs.length; i++) {
        if (j < i) j = i;
        while (j + 1 < byTs.length && byTs[j + 1].ts - byTs[i].ts <= windowMs) j++;
        const inWindow = new Set(byTs.slice(i, j + 1).map((e) => e.from));
        if (inWindow.size >= minSources) {
          withinWindow = true;
          break;
        }
      }
      if (!withinWindow) continue;
    }
    const tss = byTs.map((e) => e.ts);
    out.push({
      hub,
      sources: [...sources].sort(),
      edgeCount: list.length,
      firstTs: tss[0],
      lastTs: tss[tss.length - 1],
      withinWindow,
    });
  }
  out.sort((a, b) => b.sources.length - a.sources.length || (a.hub < b.hub ? -1 : 1));
  return out;
}

/** Mirror of detectFanIn: one hub -> >= minTargets distinct targets. */
export function detectFanOut(edges, { minTargets = 10, windowMs = null } = {}) {
  if (!Array.isArray(edges)) fail("emissary_ring_bad_edges", "edges must be an array");
  const flipped = edges.map((e) => ({ ...e, from: e.to, to: e.from }));
  return detectFanIn(flipped, { minSources: minTargets, windowMs }).map((r) => ({
    hub: r.hub,
    targets: r.sources,
    edgeCount: r.edgeCount,
    firstTs: r.firstTs,
    lastTs: r.lastTs,
    withinWindow: r.withinWindow,
  }));
}

// ---------------------------------------------------------------------------
// burst — sliding-window synchrony
// ---------------------------------------------------------------------------

/**
 * detectBursts(edges, { windowMs, minCount }) -> [{ start, end, count, parties }]
 * Maximal sliding windows holding >= minCount transfers. Script-driven
 * rings move in lockstep; organic flows do not.
 */
export function detectBursts(edges, { windowMs = 60_000, minCount = 10 } = {}) {
  if (!Array.isArray(edges)) fail("emissary_ring_bad_edges", "edges must be an array");
  const sorted = [...edges].sort((a, b) => a.ts - b.ts);
  const bursts = [];
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (j < i) j = i;
    while (j + 1 < sorted.length && sorted[j + 1].ts - sorted[i].ts <= windowMs) j++;
    const count = j - i + 1;
    if (count >= minCount) {
      const windowEdges = sorted.slice(i, j + 1);
      const parties = new Set();
      for (const e of windowEdges) {
        parties.add(e.from);
        parties.add(e.to);
      }
      bursts.push({
        start: sorted[i].ts,
        end: sorted[j].ts,
        count,
        parties: [...parties].sort(),
      });
    }
  }
  // Dedupe overlapping windows: keep the widest (max count, then earliest).
  bursts.sort((a, b) => b.count - a.count || a.start - b.start);
  const kept = [];
  for (const b of bursts) {
    const overlaps = kept.some((k) => b.start <= k.end && k.start <= b.end);
    if (!overlaps) kept.push(b);
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

// ---------------------------------------------------------------------------
// refund_loop — proceeds returning to a hub
// ---------------------------------------------------------------------------

/**
 * detectRefundLoops(edges, { maxHops }) -> [{ hub, path, hops }]
 * Finds directed cycles: proceeds leaving a hub and coming back within
 * maxHops. The cash-out leg of a ring is often a loop: collector ->
 * bridge -> destination -> ... -> collector re-seed.
 */
export function detectRefundLoops(edges, { maxHops = 4 } = {}) {
  if (!Array.isArray(edges)) fail("emissary_ring_bad_edges", "edges must be an array");
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    adj.get(e.from).add(e.to);
  }
  const loops = [];
  const seen = new Set();
  const dfs = (start, current, path, depth) => {
    if (depth > maxHops) return;
    for (const next of adj.get(current) || []) {
      if (next === start) {
        // A cycle has path.length + 1 edges (the closing edge back to
        // start): a self-loop is 1 hop, a triangle is 3.
        const cycle = [start, ...path, start];
        const key = cycle.join(">");
        if (!seen.has(key)) {
          seen.add(key);
          loops.push({ hub: start, path: cycle, hops: path.length + 1 });
        }
        continue;
      }
      if (path.includes(next) || depth + 1 > maxHops) continue;
      dfs(start, next, [...path, next], depth + 1);
    }
  };
  for (const start of adj.keys()) dfs(start, start, [], 0);
  loops.sort((a, b) => a.hops - b.hops || (a.hub < b.hub ? -1 : 1));
  return loops;
}

// ---------------------------------------------------------------------------
// Multi-signal rule — detectRings
// ---------------------------------------------------------------------------

/**
 * detectRings(graph, opts) -> { signals, findings, excluded }
 *
 * Runs every signal over the graph, groups signals by entity (hub id or
 * cluster key), and emits a FINDING only for groups with >= 3 distinct
 * signals. Single- and double-signal observations are EXCLUDED from
 * findings and written to the caller-owned journal as excluded
 * observations — they are watched, not flagged.
 *
 * opts: { minSources, minTargets, fanWindowMs, burstWindowMs, burstMinCount,
 *         maxHops, clusterMinSize, clusterHubMin, journal }
 *
 * The journal (if given) receives one record per group:
 *   { kind: "finding" | "exclusion", entities, signals, evidence, at }
 * Nothing is ever auto-punished; the caller decides what a finding means.
 */
export function detectRings(graph, opts = {}) {
  assertGraph(graph);
  const {
    minSources = 10,
    minTargets = 10,
    fanWindowMs = null,
    burstWindowMs = 60_000,
    burstMinCount = 10,
    maxHops = 4,
    clusterMinSize = 3,
    journal = null,
  } = opts;

  const groups = new Map(); // groupKey -> { entities:Set, signals:Map(name -> evidence) }
  const addSignal = (key, entities, name, evidence) => {
    if (!groups.has(key)) groups.set(key, { entities: new Set(), signals: new Map() });
    const g = groups.get(key);
    for (const e of entities) g.entities.add(e);
    g.signals.set(name, evidence);
  };

  // cluster_link — keyed by cluster signature
  const clusters = clusterEntities(graph.nodes, { minSize: clusterMinSize });
  for (const c of clusters) {
    addSignal(`cluster:${c.members.join(",")}`, c.members, "cluster_link", {
      size: c.members.length,
      via: c.via,
    });
  }

  // cluster -> hub attribution: when the members of one entity-cluster
  // overwhelmingly transact with a single counterparty, the cluster is
  // entity-linked to that hub. A farm of sock-puppets feeding one
  // collector is exactly this shape — and it is what lets the
  // multi-signal rule fire: fan_in + burst + cluster_link on one hub.
  const clusterHubMin = opts.clusterHubMin ?? minSources;
  for (const c of clusters) {
    const memberSet = new Set(c.members);
    const counterparties = new Map(); // counterparty -> Set of members
    for (const e of graph.edges) {
      if (memberSet.has(e.from) && !memberSet.has(e.to)) {
        if (!counterparties.has(e.to)) counterparties.set(e.to, new Set());
        counterparties.get(e.to).add(e.from);
      }
      if (memberSet.has(e.to) && !memberSet.has(e.from)) {
        if (!counterparties.has(e.from)) counterparties.set(e.from, new Set());
        counterparties.get(e.from).add(e.to);
      }
    }
    for (const [cp, members] of counterparties) {
      if (members.size >= clusterHubMin) {
        addSignal(`hub:${cp}`, [...members], "cluster_link", {
          size: c.members.length,
          via: c.via,
          linkedHub: cp,
          membersTransacting: members.size,
        });
      }
    }
  }

  // fan_in / fan_out — keyed by hub
  for (const f of detectFanIn(graph.edges, { minSources, windowMs: fanWindowMs })) {
    addSignal(`hub:${f.hub}`, [f.hub, ...f.sources], "fan_in", {
      sources: f.sources.length,
      edgeCount: f.edgeCount,
      spanMs: f.lastTs - f.firstTs,
      withinWindow: f.withinWindow,
    });
  }
  for (const f of detectFanOut(graph.edges, { minTargets, windowMs: fanWindowMs })) {
    addSignal(`hub:${f.hub}`, [f.hub, ...f.targets], "fan_out", {
      targets: f.targets.length,
      edgeCount: f.edgeCount,
      spanMs: f.lastTs - f.firstTs,
      withinWindow: f.withinWindow,
    });
  }

  // burst — keyed by the dominant hub in the window, else by window
  for (const b of detectBursts(graph.edges, { windowMs: burstWindowMs, minCount: burstMinCount })) {
    const hubCounts = new Map();
    for (const p of b.parties) hubCounts.set(p, 0);
    const windowEdges = graph.edges.filter((e) => e.ts >= b.start && e.ts <= b.end);
    for (const e of windowEdges) {
      hubCounts.set(e.from, (hubCounts.get(e.from) || 0) + 1);
      hubCounts.set(e.to, (hubCounts.get(e.to) || 0) + 1);
    }
    let dominant = null;
    let best = 0;
    for (const [p, c] of hubCounts) {
      if (c > best) {
        best = c;
        dominant = p;
      }
    }
    const key = dominant ? `hub:${dominant}` : `window:${b.start}-${b.end}`;
    addSignal(key, b.parties, "burst", {
      count: b.count,
      spanMs: b.end - b.start,
      parties: b.parties.length,
      dominantHub: dominant,
    });
  }

  // refund_loop — keyed by hub
  for (const l of detectRefundLoops(graph.edges, { maxHops })) {
    addSignal(`hub:${l.hub}`, l.path, "refund_loop", { hops: l.hops, path: l.path });
  }

  const findings = [];
  const excluded = [];
  const at = Date.now();
  for (const [key, g] of groups) {
    const signals = [...g.signals.keys()].sort();
    const record = {
      key,
      entities: [...g.entities].sort(),
      signals,
      evidence: Object.fromEntries(g.signals),
      at,
    };
    if (signals.length >= 3) {
      findings.push({ ...record, kind: "finding", disposition: "multi-signal" });
      if (journal) journal.push({ ...record, kind: "finding" });
    } else {
      excluded.push({ ...record, kind: "exclusion", reason: "below multi-signal threshold" });
      if (journal) journal.push({ ...record, kind: "exclusion", reason: "below multi-signal threshold" });
    }
  }
  findings.sort((a, b) => b.signals.length - a.signals.length || (a.key < b.key ? -1 : 1));
  excluded.sort((a, b) => b.signals.length - a.signals.length || (a.key < b.key ? -1 : 1));
  return { signals: [...groups.values()].map((g) => [...g.signals.keys()]), findings, excluded };
}

/** True when the source text contains no 0x-prefixed 40-hex-char address. */
export const REAL_ADDRESS_RE = /0x[0-9a-fA-F]{40}\b/;

export const SYNTH_ID_RE = /^SYNTH-[A-Za-z0-9-]+$/;
