import { randomBelow } from "../game/blackjack";
import type { Env } from "../durable-objects/room";
export { BlackjackRoom } from "../durable-objects/room";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const createLimits = new Map<string, { window: number; count: number }>();
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function secured(response: Response, hidden = false): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders))
    headers.set(key, value);
  if (hidden) headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, headers });
}
function error(message: string, status: number): Response {
  return secured(
    Response.json(
      { error: message },
      { status, headers: { "Cache-Control": "no-store" } },
    ),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    if (path.startsWith("/api/")) {
      const origin = request.headers.get("Origin");
      if (origin !== url.origin)
        return error("Open this table on its own website.", 403);
      if (request.headers.get("Sec-Fetch-Site") === "cross-site")
        return error("Cross-site requests are not allowed.", 403);
      if (request.method === "POST") {
        if (
          !request.headers.get("Content-Type")?.startsWith("application/json")
        )
          return error("JSON required.", 415);
        if (Number(request.headers.get("Content-Length")) > 2048)
          return error("Request too large.", 413);
        const body = await request.text();
        if (body.length > 2048) return error("Request too large.", 413);
        request = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body,
        });
      }
      if (path === "/api/rooms" && request.method === "POST") {
        const key = request.headers.get("CF-Connecting-IP") ?? "local";
        const now = Date.now();
        for (const [ip, value] of createLimits)
          if (now - value.window > 60000) createLimits.delete(ip);
        const rate = createLimits.get(key) ?? { window: now, count: 0 };
        createLimits.set(key, rate);
        if (++rate.count > 10)
          return error("Too many tables created. Try again in a minute.", 429);
        let input: { nickname?: unknown };
        try {
          input = (await request.json()) as typeof input;
        } catch {
          return error("Invalid JSON.", 400);
        }
        for (let tries = 0; tries < 5; tries++) {
          const code = Array.from(
            { length: 6 },
            () => alphabet[randomBelow(alphabet.length)],
          ).join("");
          const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
          const response = await stub.fetch(
            new Request("https://room/initialize", {
              method: "POST",
              body: JSON.stringify({ code, nickname: input?.nickname }),
            }),
          );
          if (response.status !== 409) return secured(response);
        }
        return error("Unable to create a table. Try again.", 503);
      }
      const route = path.match(
        /^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/(join|socket)$/,
      );
      if (
        route &&
        ((route[2] === "join" && request.method === "POST") ||
          (route[2] === "socket" && request.method === "GET"))
      ) {
        const internal = new URL(request.url);
        internal.pathname = `/${route[2]}`;
        return secured(
          await env.ROOMS.get(env.ROOMS.idFromName(route[1])).fetch(
            new Request(internal, request),
          ),
        );
      }
      return error("Not found.", 404);
    }
    if (!["GET", "HEAD"].includes(request.method))
      return error("Method not allowed.", 405);
    if (path === "/home" || path === "/blackjack")
      return secured(Response.redirect(`${url.origin}${path}/`, 308));
    const assetUrl = new URL(request.url);
    if (path === "/") assetUrl.pathname = "/index.html";
    else if (path === "/home/") assetUrl.pathname = "/home/index.html";
    else if (
      path === "/blackjack/" ||
      /^\/blackjack\/room\/[A-HJ-NP-Z2-9]{6}\/?$/.test(path)
    )
      assetUrl.pathname = "/blackjack/index.html";
    return secured(
      await env.ASSETS.fetch(new Request(assetUrl, request)),
      path.startsWith("/home"),
    );
  },
} satisfies ExportedHandler<Env>;
