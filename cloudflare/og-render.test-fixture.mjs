// Test fixture for og-render.check.mjs: the smallest worker that exercises
// the runtime OG renderer the way server/http.mjs does for receipt cards.
import { renderOgPng } from "../server/og-render.mjs";

export default {
  async fetch() {
    const png = await renderOgPng({
      title: "MCP endpoint path consistency audit",
      subtitle: "Artifact hash recorded — delivery hash recorded at submission",
      badges: ["Artifact hash recorded", "public-work-garden", "2026-10-19"],
      footer: "Project Room receipt · hashes are stored values, not re-verified",
    });
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  },
};
