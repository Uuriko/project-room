// Demand-side job-flow simulator (200-hard-tasks #30).
// Queueing simulator for the demand constraint: given provider capacity and
// job arrival rates, find where the system saturates and what pricing clears
// it. Discrete-event simulation with configurable arrival/service
// distributions (exponential, deterministic, uniform). Seeded RNG =>
// deterministic runs.
// Model: C provider slots (parallel servers), one FIFO queue, jobs arrive
// per the arrival process and take serviceTime each. Metrics: utilization,
// mean/max queue wait, throughput, saturation point, dropped (impatient) jobs.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(dist, rand) {
  switch (dist.kind) {
    case "exponential":
      return -Math.log(1 - rand()) * dist.mean;
    case "deterministic":
      return dist.mean;
    case "uniform":
      return dist.min + rand() * (dist.max - dist.min);
    default:
      throw new Error(`unknown distribution: ${dist.kind}`);
  }
}

// Demand curve: arrival rate (jobs/sec) as a function of price ($/job).
// Isoelastic: lambda(price) = baseLambda * (basePrice / price)^elasticity.
export function demandAtPrice({ baseLambda, basePrice, elasticity, price }) {
  if (price <= 0) throw new Error("demandAtPrice: price must be > 0");
  return baseLambda * Math.pow(basePrice / price, elasticity);
}

export function simulate({
  providers,
  arrival,
  service,
  durationSec,
  seed = 1,
  maxQueueWaitSec = Infinity, // jobs waiting longer abandon (lost demand)
}) {
  if (providers < 1) throw new Error("simulate: providers must be >= 1");
  const rand = mulberry32(seed);
  // Event-driven: next arrival time; each provider has a free-at time.
  const freeAt = new Array(providers).fill(0);
  const queue = []; // { arrivedAt }
  let t = 0;
  let nextArrival = sample(arrival, rand);
  const waits = [];
  let served = 0;
  let abandoned = 0;
  let busyTime = 0;
  let maxWait = 0;

  // Serve queued jobs whenever a provider is free, in event order.
  function pump(now) {
    for (let p = 0; p < providers; p++) {
      while (queue.length > 0 && freeAt[p] <= now) {
        const job = queue.shift();
        const wait = now - job.arrivedAt;
        if (wait > maxQueueWaitSec) {
          abandoned++;
          continue;
        }
        const svc = sample(service, rand);
        freeAt[p] = now + svc;
        busyTime += svc;
        waits.push(wait);
        if (wait > maxWait) maxWait = wait;
        served++;
      }
    }
  }

  while (t < durationSec) {
    t = nextArrival;
    if (t >= durationSec) break;
    // Advance providers to t and serve the queue first (FIFO across providers).
    queue.push({ arrivedAt: t });
    // Assign the new job (and any backlog) to the earliest-free provider.
    let p = 0;
    for (let i = 1; i < providers; i++) if (freeAt[i] < freeAt[p]) p = i;
    const startAt = Math.max(t, freeAt[p]);
    const job = queue.shift();
    const wait = startAt - job.arrivedAt;
    if (wait > maxQueueWaitSec) {
      abandoned++;
    } else {
      const svc = sample(service, rand);
      freeAt[p] = startAt + svc;
      busyTime += svc;
      waits.push(wait);
      if (wait > maxWait) maxWait = wait;
      served++;
    }
    void pump;
    nextArrival = t + sample(arrival, rand);
  }

  waits.sort((a, b) => a - b);
  const pct = (q) => (waits.length ? waits[Math.min(waits.length - 1, Math.floor(q * waits.length))] : 0);
  const mean = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;
  return {
    providers,
    durationSec,
    seed,
    arrived: served + abandoned + queue.length,
    served,
    abandoned,
    utilization: Math.min(1, busyTime / (providers * durationSec)), // capped: service spilling past the window is not >100% busy
    meanWaitSec: +mean.toFixed(3),
    p50WaitSec: +pct(0.5).toFixed(3),
    p95WaitSec: +pct(0.95).toFixed(3),
    maxWaitSec: +maxWait.toFixed(3),
    throughputPerSec: +(served / durationSec).toFixed(4),
  };
}

// Sweep arrival rates at fixed capacity: find the saturation knee, defined
// as the first arrival rate where p95 wait exceeds `sloSec`. Coarse sweep
// first, then bisection between the last clean point and the first breach
// for a tight knee.
export function findSaturation({ providers, service, sloSec = 30, seed = 1, durationSec = 3600 }) {
  const run = (lambda, s) =>
    simulate({
      providers,
      arrival: { kind: "exponential", mean: 1 / lambda },
      service,
      durationSec,
      seed: s,
      maxQueueWaitSec: 600,
    });
  let lo = 0.01;
  let hi = null;
  const points = [];
  for (const lambda of [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0]) {
    const r = run(lambda, seed);
    points.push({ lambda, ...r });
    if (r.p95WaitSec > sloSec) {
      hi = lambda;
      break;
    }
    lo = lambda;
  }
  if (hi === null) return { knee: null, note: "no breach up to 3.0 jobs/s", points };
  // Bisect the knee between the last clean lambda and the first breach.
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    const r = run(mid, seed + i + 1); // fresh seeds: the knee must be robust, not seed-lucky
    if (r.p95WaitSec > sloSec) hi = mid;
    else lo = mid;
  }
  const knee = +((lo + hi) / 2).toFixed(4);
  return { knee, points, cleanLambda: +lo.toFixed(4), breachLambda: +hi.toFixed(4) };
}

// Given a demand curve, find the price that keeps p95 wait under sloSec at
// the given capacity: the market-clearing price. Binary search on price
// (higher price -> lower lambda -> lower wait), then verify the result on
// fresh seeds with a 10% safety margin — the price must clear robustly,
// not just on the search seed.
export function clearingPrice({ providers, service, demand, sloSec = 30, seed = 1 }) {
  const runAtPrice = (price, s) => {
    const lambda = demandAtPrice({ ...demand, price });
    return {
      lambda,
      r: simulate({
        providers,
        arrival: { kind: "exponential", mean: 1 / Math.max(lambda, 1e-9) },
        service,
        durationSec: 1800,
        seed: s,
        maxQueueWaitSec: 600,
      }),
    };
  };
  let lo = 0.01;
  let hi = 10;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (runAtPrice(mid, seed).r.p95WaitSec <= sloSec) hi = mid;
    else lo = mid;
  }
  // Verify on fresh seeds; raise with margin until all pass (max 8 rounds).
  let price = hi * 1.1;
  for (let round = 0; round < 8; round++) {
    const seeds = [seed + 101 + round * 3, seed + 102 + round * 3, seed + 103 + round * 3];
    const worst = Math.max(...seeds.map((s) => runAtPrice(price, s).r.p95WaitSec));
    if (worst <= sloSec) break;
    price *= 1.15;
  }
  const lambda = demandAtPrice({ ...demand, price });
  return { price: +price.toFixed(3), lambdaAtPrice: +lambda.toFixed(4) };
}
