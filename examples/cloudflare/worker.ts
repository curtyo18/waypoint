import { Waypoint } from "waypoint";
import { DurableObjectAdmissionStore } from "./admission-store-do.js";
import type { AdmissionStoreEnv } from "./admission-store-do.js";

export { CounterDO } from "./counter-do.js";

type Env = AdmissionStoreEnv & {
  WAYPOINT_SECRET: string;
};

const COOKIE_NAME = "waypoint";
const SESSION_COOKIE = "wp_sid";
// In a real deployment the waiting page is hosted at a stable, separate
// URL — this constant is just a placeholder to show the redirect shape.
const WAITING_PAGE = "/__waiting";

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return rest.join("=");
    }
  }
  return undefined;
}

function setCookieHeader(name: string, value: string): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/`;
}

function originResponse(): Response {
  // Stand-in for a real origin fetch. In production this would be
  // `fetch(originRequest)` against your protected backend.
  return Response.json({ message: "you're in" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let sessionId = readCookie(request, SESSION_COOKIE);
    let setSessionHeader: string | undefined;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      setSessionHeader = setCookieHeader(SESSION_COOKIE, sessionId);
    }

    const room = new Waypoint<Record<string, string>>({
      secret: env.WAYPOINT_SECRET,
      waitSeconds: { min: 30, max: 120 },
      activeSeconds: 600,
      admissionCap: {
        perSlot: 50,
        slotSeconds: 10,
        store: new DurableObjectAdmissionStore(env),
        // Default; spelled out for the reader.
        onStoreError: "open",
      },
    });

    const verdict = await room.evaluate({
      cookie: readCookie(request, COOKIE_NAME),
      bindings: { sessionId },
    });

    const headers = new Headers();
    if (setSessionHeader) headers.append("Set-Cookie", setSessionHeader);

    if (verdict.action === "pass") {
      const res = originResponse();
      headers.forEach((val, key) => res.headers.append(key, val));
      return res;
    }

    if (verdict.action === "admit") {
      headers.append("Set-Cookie", setCookieHeader(COOKIE_NAME, verdict.cookie));
      const res = originResponse();
      headers.forEach((val, key) => res.headers.append(key, val));
      return res;
    }

    // wait — set the (possibly fresh) waiting cookie and 302 to the
    // waiting page with the original URL and the entryAt timestamp.
    headers.append("Set-Cookie", setCookieHeader(COOKIE_NAME, verdict.cookie));
    const target = new URL(WAITING_PAGE, request.url);
    target.searchParams.set("returnTo", request.url);
    target.searchParams.set("t", String(verdict.entryAt));
    headers.set("Location", target.toString());
    return new Response(null, { status: 302, headers });
  },
};
