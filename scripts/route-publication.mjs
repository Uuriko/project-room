#!/usr/bin/env node
// #3674: every public route-table row carries a publication declaration —
// the route table's answer to "which publication gate does this public read
// pass through?", in the same shape as the TST-08 parity note.
//   publication: "gate:public-visibility"  the read passes through the one
//                     publication gate (server/public-visibility.mjs)
//   publication: "open:<reason>"           the surface serves no gated
//                     content; the reason says why (8+ chars)
// A "public route" is a row with scope: "public" — the table's own marker
// for an unauthenticated public read. Rows with any other scope are
// authenticated or room-bound and are not publication surfaces; a
// declaration on them is still shape-checked when present.
//
// Fail-closed: an undeclared public row has NO publication policy, so the
// registry treats it as closed — publicationProblems reports it and the
// gate goes red. There is no grandfather baseline: declare the row.
//   node scripts/route-publication.mjs   # report, exit 1 on problems
import { fileURLToPath } from "node:url";

export function isPublicRoute(row) { return row?.scope === "public"; }

// The publication policy a row effectively has. Undeclared is not a
// policy: it resolves to null, which isPublishable reads as closed.
export function effectivePublication(row) {
  return typeof row?.publication === "string" ? row.publication : null;
}

export function isPublishable(row, notePattern) {
  const note = effectivePublication(row);
  return note !== null && notePattern.test(note);
}

export function publicationProblems(routes, notePattern) {
  const problems = [];
  for (const row of routes) {
    if (row.publication !== undefined) {
      if (!notePattern.test(String(row.publication))) {
        problems.push(`${row.id}: publication note "${row.publication}" is not gate:public-visibility or open:<reason of 8+ chars>`);
      }
      continue;
    }
    if (isPublicRoute(row)) {
      problems.push(`${row.id} (${row.method} ${row.path}): add publication: "gate:public-visibility" or "open:<reason>" — an undeclared public route is treated as closed`);
    }
  }
  return problems;
}

async function main() {
  const { ROUTES, ROUTE_PUBLICATION_NOTE } = await import("../server/routes/table.mjs");
  const problems = publicationProblems(ROUTES, ROUTE_PUBLICATION_NOTE);
  const publicRoutes = ROUTES.filter(isPublicRoute);
  const declared = publicRoutes.filter(row => row.publication !== undefined).length;
  console.log(`routes ${ROUTES.length}, public ${publicRoutes.length}, with publication declaration ${declared}, problems ${problems.length}`);
  for (const line of problems) console.log(`  ${line}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().then(code => process.exit(code));
