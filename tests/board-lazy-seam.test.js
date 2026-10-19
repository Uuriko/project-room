// The board's lazy seam must stay honest: board-ui.js may only reach the
// app through the dynamic import behind lazyDisclosure / the claim-chat
// painter's shared loader. A static import in app.js silently puts the
// whole board closure (125 KB, 4 modules) back on the boot path — it did
// exactly that for paintClaimChat while a lazy registration for the same
// module sat below it claiming the board was deferred (ATLAS-CLIENT W-3).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

test("app.js has no static import of board-ui.js", () => {
  assert.doesNotMatch(app, /(?:import|export)[^'"]*?from\s*["']\.\/board-ui\.js["']/,
    "board-ui.js must load through import() only; a static import defeats the lazy seam");
  assert.doesNotMatch(app, /import\s*["']\.\/board-ui\.js["']/,
    "a bare static import of board-ui.js defeats the lazy seam");
});

test("the board panel and the claim-chat painter share one lazy loader", () => {
  assert.match(app, /import\("\.\/board-ui\.js"\)/, "board-ui.js is dynamically imported");
  assert.match(app, /load:\s*loadBoardModule/, "lazyDisclosure loads through the shared loader");
  assert.match(app, /claimChatPainter\(state, \$\("#message-list"\)\)/,
    "the claim-chat painter still paints the message list once the module lands");
});
