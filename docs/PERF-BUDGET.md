# Page-weight budget (PERF-0)

One command measures signed-out pages the same way every time, so the PERF-1 work (signed-out boot module, then lazy app panels) can quote before and after numbers from the same tool.

```sh
node scripts/perf-budget.mjs                                   # local server, 5 pages, 390 + 1280 px
node scripts/perf-budget.mjs --pages / --viewport 390          # one page, one width
node scripts/perf-budget.mjs --origin https://room.trydemigod.com --out perf.json
node scripts/perf-budget.mjs --network none                    # CPU throttling only
```

## Method
- Each page loads in a fresh Chromium context: empty cache, service workers blocked, no sign-in. GET requests only, so it is safe against a deployed origin.
- CPU throttling 4x through CDP (`Emulation.setCPUThrottlingRate`).
- Network throttling through CDP (`Network.emulateNetworkConditions`): widths under 600 px use the mobile profile (150 ms RTT, 1.6 Mbps down, 750 Kbps up, Lighthouse's mobile numbers); wider viewports use desktop (40 ms RTT, 10 Mbps). `--network none` turns it off.
- **requests**: network requests the page made (data: URLs excluded). **bytes**: CDP `encodedDataLength`, the bytes on the wire. **domNodes**: elements in the document after load. **lcpMs**: the last `largest-contentful-paint` entry after the network is idle plus 1.5 s.
- Without `--origin` the tool starts a throwaway `createRoomServer` on an empty temporary database. The local server does not compress, so local bytes are larger than deployed bytes. Compare local with local and deployed with deployed.
- Lab LCP here uses DevTools throttling on the real page. Lighthouse reports a simulated LCP and gives larger numbers for `/` (QA5: 3.3 s on `d95d0431`; QA5-R: 2.4 s on `de4fd4a2`). Requests and bytes are the stable signals; quote Lighthouse mobile alongside when a PR claims an LCP change.

## Budget (D5-5, approved)
Signed-out `/` at 390 px: Lighthouse mobile LCP at most 2.5 s, TBT at most 200 ms, **at most 15 requests and 150 KB** before interaction. Every other public page already fits.

## Baseline

### Deployed: `adfd201a` on room.trydemigod.com (2026-10-04T20:18Z)
| Page | Width | Network | Requests | Bytes | DOM nodes | Lab LCP (ms) |
|---|---|---|---|---|---|---|
| `/` | 390 | mobile | 60 | 543,840 | 1488 | 984 |
| `/room` | 390 | mobile | 2 | 6,836 | 129 | 360 |
| `/about` | 390 | mobile | 3 | 14,028 | 43 | 288 |
| `/agents` | 390 | mobile | 3 | 13,750 | 77 | 288 |
| `/receipts` | 390 | mobile | 3 | 13,935 | 47 | 260 |
| `/` | 1280 | desktop | 60 | 543,322 | 1488 | 320 |
| `/room` | 1280 | desktop | 2 | 6,831 | 129 | 252 |
| `/about` | 1280 | desktop | 3 | 14,011 | 43 | 160 |
| `/agents` | 1280 | desktop | 3 | 13,726 | 77 | 176 |
| `/receipts` | 1280 | desktop | 3 | 13,953 | 47 | 180 |

### Local: main `769f6686` (uncompressed)
| Page | Width | Network | Requests | Bytes | DOM nodes | Lab LCP (ms) |
|---|---|---|---|---|---|---|
| `/` | 390 | mobile | 58 | 1,887,631 | 1487 | 2060 |
| `/room` | 390 | mobile | 1 | 18,082 | 128 | 292 |
| `/about` | 390 | mobile | 1 | 5,515 | 42 | 240 |
| `/agents` | 390 | mobile | 1 | 3,424 | 37 | 256 |
| `/receipts` | 390 | mobile | 1 | 4,756 | 35 | 244 |
| `/` | 1280 | desktop | 58 | 1,887,631 | 1487 | 552 |
| `/room` | 1280 | desktop | 1 | 18,082 | 128 | 220 |
| `/about` | 1280 | desktop | 1 | 5,515 | 42 | 132 |
| `/agents` | 1280 | desktop | 1 | 3,424 | 37 | 132 |
| `/receipts` | 1280 | desktop | 1 | 4,756 | 35 | 128 |

`/` is the outlier: about 60 requests and 540 KB on the wire (1.9 MB uncompressed) and about 1,490 DOM nodes, against 1-3 requests and under 20 KB for every other public page. That is the gap PERF-1 closes.
