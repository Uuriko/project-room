// Operator configuration only; never a Room permission or request parameter.
export function maintenanceEnabled(value = "0") {
  if (!["0", "1"].includes(value)) throw new Error("ROOM_MAINTENANCE must be 0 or 1");
  return value === "1";
}

export function maintenanceReply(pathname = "/") {
  const api = pathname.startsWith("/api/");
  return { status: 503, headers: { "Content-Type": api ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store", "Retry-After": "60", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" },
  body: api ? JSON.stringify({ error: { code: "maintenance", message: "Room is temporarily paused. Please try again later." } })
    : "Project Room is temporarily paused.\nPlease try again later.\n" };
}

export const maintenanceResponse = request => {
  const { status, headers, body } = maintenanceReply(new URL(request.url).pathname);
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
};
