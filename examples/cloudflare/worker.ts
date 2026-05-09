import { Waypoint, defaultLotteryCheck } from "waypoint";
import { DurableObjectAdmissionStore } from "./admission-store-do.js";
import type { AdmissionStoreEnv } from "./admission-store-do.js";

export { CounterDO } from "./counter-do.js";

type Env = AdmissionStoreEnv & {
  WAYPOINT_SECRET: string;
  ASSETS: { fetch(req: Request): Promise<Response> };
};

const COOKIE_NAME = "waypoint";
const SESSION_COOKIE = "wp_sid";
const WAITING_PATH = "/__waiting";
const DEMO_PATH = "/__demo";
const STATE_PATH = "/__demo/state";
const RESET_PATH = "/__demo/reset";

const WAIT_SECONDS = { min: 10, max: 60 };
const ACTIVE_SECONDS = 600;
const ADMISSION_PER_SLOT = 50;
const SLOT_SECONDS = 5;
// Lottery: 30% lucky chance is high for a demo (production would be 1–5%)
// so visitors actually see both buckets when clicking around.
const LOTTERY_CHANCE = 0.3;
const LUCKY_WAIT_SECONDS = { min: 1, max: 5 };

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

function clearCookieHeader(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function makeRoom(env: Env): Waypoint<Record<string, string>> {
  return new Waypoint<Record<string, string>>({
    secret: env.WAYPOINT_SECRET,
    waitSeconds: WAIT_SECONDS,
    activeSeconds: ACTIVE_SECONDS,
    lottery: {
      luckyChance: LOTTERY_CHANCE,
      luckyWaitSeconds: LUCKY_WAIT_SECONDS,
    },
    admissionCap: {
      perSlot: ADMISSION_PER_SLOT,
      slotSeconds: SLOT_SECONDS,
      store: new DurableObjectAdmissionStore(env),
      onStoreError: "open",
    },
  });
}

// The "real site" — the page a successful admission lands on. Renders
// some friendly copy plus a small status footer pointing back at the
// demo panel.
function mockOriginHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>The Demo Shop — Limited Edition Widget</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; background: #fafafa; }
    h1 { margin-bottom: 0.25rem; }
    .price { font-size: 1.5rem; font-weight: 600; margin: 0.5rem 0 1.5rem; }
    .badge { display: inline-block; background: #d4f4dd; color: #0a5d28; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
    .product { background: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04); }
    button { background: #1a1a1a; color: #fff; border: 0; padding: 0.75rem 1.5rem; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; }
    .footer { margin-top: 2rem; font-size: 0.85rem; color: #666; }
    .footer a { color: #0066cc; }
  </style>
</head>
<body>
  <article class="product">
    <span class="badge">You're in</span>
    <h1>Limited Edition Widget</h1>
    <p class="price">£24.99</p>
    <p>You waited in line and waypoint let you through. This page is the "real site" — the protected origin behind the gate. Refresh as much as you like; your active cookie keeps you in for the configured window.</p>
    <p><button>Add to bag</button></p>
  </article>
  <p class="footer">
    <a href="${DEMO_PATH}">→ open the demo panel</a> to inspect cookie state, the slot counter, and the configured knobs.
  </p>
</body>
</html>`;
}

// Demo control panel. Self-contained HTML; polls /__demo/state for live
// updates of the cookie state and the per-slot counter.
function demoPanelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>waypoint demo panel</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; background: #f5f5f5; }
    h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
    h2 { margin: 1.5rem 0 0.5rem; font-size: 1rem; text-transform: uppercase; letter-spacing: 0.05em; color: #666; }
    .panel { background: #fff; padding: 1.5rem; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-bottom: 1rem; }
    .row { display: grid; grid-template-columns: 9rem 1fr; gap: 0.5rem 1rem; align-items: baseline; }
    .row dt { color: #666; font-size: 0.9rem; }
    .row dd { margin: 0; font-family: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, monospace; font-size: 0.9rem; word-break: break-all; }
    .pill { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
    .pill-fresh { background: #e0e0e0; color: #444; }
    .pill-waiting { background: #fff4d4; color: #6b5400; }
    .pill-active { background: #d4f4dd; color: #0a5d28; }
    .pill-lucky { background: #d4f4dd; color: #0a5d28; }
    .pill-unlucky { background: #ffe5e5; color: #861515; }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    button, .btn { background: #1a1a1a; color: #fff; border: 0; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.9rem; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; }
    .btn-secondary { background: #fff; color: #1a1a1a; border: 1px solid #ccc; }
    .slots { font-family: ui-monospace, monospace; font-size: 0.85rem; }
    .slot-bar { display: inline-block; background: #e0e0e0; height: 0.5rem; vertical-align: middle; margin-left: 0.5rem; border-radius: 2px; overflow: hidden; }
    .slot-fill { background: #1a1a1a; height: 100%; }
    .slot-fill.full { background: #c00; }
    .help { color: #666; font-size: 0.85rem; margin-top: 0.5rem; }
    code { background: #eee; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>waypoint demo panel</h1>
  <p class="help">Live view of the gate's cookie state and the Durable Object's per-slot admission counters. Polls every second.</p>

  <section class="panel">
    <h2>Your state</h2>
    <dl class="row">
      <dt>Phase</dt><dd id="phase"><span class="pill pill-fresh">loading</span></dd>
      <dt>Lottery bucket</dt><dd id="bucket">—</dd>
      <dt>sessionId</dt><dd id="sessionId">—</dd>
      <dt>entryAt</dt><dd id="entryAt">—</dd>
      <dt>Time until / since</dt><dd id="countdown">—</dd>
      <dt>Active expires</dt><dd id="activeExp">—</dd>
    </dl>
    <h2>Actions</h2>
    <div class="actions">
      <a class="btn" href="/">→ Visit the gated site (/)</a>
      <a class="btn btn-secondary" href="${RESET_PATH}">Reset cookies (re-roll)</a>
    </div>
    <p class="help">Open the gated site in another <em>incognito</em> window to act as a parallel user against the same DO counter.</p>
  </section>

  <section class="panel">
    <h2>Configuration (compile-time in worker.ts)</h2>
    <dl class="row">
      <dt>waitSeconds</dt><dd id="cfg-wait">—</dd>
      <dt>activeSeconds</dt><dd id="cfg-active">—</dd>
      <dt>luckyChance</dt><dd id="cfg-luckychance">—</dd>
      <dt>luckyWaitSeconds</dt><dd id="cfg-luckywait">—</dd>
      <dt>perSlot</dt><dd id="cfg-perslot">—</dd>
      <dt>slotSeconds</dt><dd id="cfg-slotsec">—</dd>
    </dl>
  </section>

  <section class="panel">
    <h2>Admission cap (live, per slot)</h2>
    <p class="help">Counters from the Durable Object. Current slot first; recent past in fade. A slot's counter resets implicitly — the next slot is a fresh key.</p>
    <div class="slots" id="slots">—</div>
  </section>

  <script>
    function fmtRel(seconds) {
      const abs = Math.abs(seconds);
      const m = Math.floor(abs / 60);
      const s = abs % 60;
      const sign = seconds < 0 ? "-" : "";
      return sign + m + "m " + s + "s";
    }

    function pill(state) {
      const text = state || "fresh";
      return '<span class="pill pill-' + text + '">' + text + '</span>';
    }

    async function poll() {
      const r = await fetch("${STATE_PATH}", { credentials: "same-origin" });
      const s = await r.json();

      document.getElementById("phase").innerHTML = pill(s.phase);
      document.getElementById("bucket").innerHTML = s.lottery.bucket ? pill(s.lottery.bucket) : "—";
      document.getElementById("sessionId").textContent = s.sessionId || "—";
      document.getElementById("entryAt").textContent = s.entryAt ? new Date(s.entryAt * 1000).toLocaleTimeString() + " (" + s.entryAt + ")" : "—";
      const cd = document.getElementById("countdown");
      if (s.phase === "waiting" && s.entryAt) {
        const delta = s.entryAt - Math.floor(Date.now() / 1000);
        cd.textContent = "admit in " + fmtRel(delta);
      } else if (s.phase === "active" && s.exitAt) {
        const delta = s.exitAt - Math.floor(Date.now() / 1000);
        cd.textContent = "expires in " + fmtRel(delta);
      } else {
        cd.textContent = "—";
      }
      document.getElementById("activeExp").textContent = s.exitAt ? new Date(s.exitAt * 1000).toLocaleTimeString() + " (" + s.exitAt + ")" : "—";

      document.getElementById("cfg-wait").textContent = s.config.waitMin + "..." + s.config.waitMax + " s";
      document.getElementById("cfg-active").textContent = s.config.activeSeconds + " s";
      document.getElementById("cfg-luckychance").textContent = (s.lottery.chance * 100).toFixed(0) + "%";
      document.getElementById("cfg-luckywait").textContent = s.lottery.luckyMin + "..." + s.lottery.luckyMax + " s";
      document.getElementById("cfg-perslot").textContent = s.config.perSlot;
      document.getElementById("cfg-slotsec").textContent = s.config.slotSeconds + " s";

      // Render the cap view as a list of recent slots with a bar.
      const slotsEl = document.getElementById("slots");
      const rows = s.slots.map(function (sl) {
        const pct = Math.min(100, Math.round((sl.count / s.config.perSlot) * 100));
        const cls = sl.count >= s.config.perSlot ? "slot-fill full" : "slot-fill";
        const dim = sl.id === s.currentSlot ? "" : "color:#999;";
        return '<div style="' + dim + '">slot ' + sl.id + ': ' + sl.count + '/' + s.config.perSlot +
          '<span class="slot-bar" style="width:120px"><span class="' + cls + '" style="display:block;width:' + pct + '%;"></span></span>' +
          (sl.id === s.currentSlot ? "  ← now" : "") +
          '</div>';
      }).join("");
      slotsEl.innerHTML = rows || "—";
    }

    poll();
    setInterval(poll, 1000);
  </script>
</body>
</html>`;
}

// Build the inline content of the static waiting page with ALLOWED_HOSTS
// patched to include the dev origin. The canonical page lives at
// static-page/index.html and ships with shop.example.com only.
async function serveWaitingPage(request: Request, env: Env): Promise<Response> {
  const assetReq = new Request(new URL("/index.html", request.url).toString(), { method: "GET" });
  const original = await env.ASSETS.fetch(assetReq);
  let html = await original.text();
  const url = new URL(request.url);
  // Inject the dev origin into the allowlist so the redirect goes back to
  // the worker, not the page-origin fallback.
  const injected = JSON.stringify([url.host]);
  html = html.replace(
    /const ALLOWED_HOSTS = \[[^\]]*\];/,
    "const ALLOWED_HOSTS = " + injected + ";",
  );
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Decode the waypoint cookie (without re-verifying — purely for display).
// The cookie is HMAC-signed; the demo panel doesn't need to re-verify
// since this endpoint is server-side and trusted.
function decodeWaypointCookie(value: string | undefined): {
  state?: string;
  entryAt?: number;
  iat?: number;
  exp?: number;
} {
  if (!value) return {};
  const parts = value.split(".");
  if (parts.length !== 3) return {};
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as {
      iat?: number;
      exp?: number;
      data?: { state?: string; entryAt?: number };
    };
    return {
      state: payload.data?.state,
      entryAt: payload.data?.entryAt,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return {};
  }
}

async function serveState(request: Request, env: Env): Promise<Response> {
  const sessionId = readCookie(request, SESSION_COOKIE);
  const decoded = decodeWaypointCookie(readCookie(request, COOKIE_NAME));

  // Compute current + recent slots and ask the DO for their counts.
  const nowSec = Math.floor(Date.now() / 1000);
  const currentSlot = Math.floor(nowSec / SLOT_SECONDS);
  const slotIds = [currentSlot - 2, currentSlot - 1, currentSlot, currentSlot + 1].map(String);
  const id = env.COUNTER.idFromName("waypoint-admissions");
  const stub = env.COUNTER.get(id);
  const peekRes = await stub.fetch(
    `https://counter/peek?slots=${slotIds.join(",")}`,
  );
  const peek = (await peekRes.json()) as { counts: Record<string, number> };
  const slots = slotIds.map((sId) => ({ id: sId, count: peek.counts[sId] ?? 0 }));

  const phase = decoded.state ?? "fresh";
  const exitAt = phase === "active" ? decoded.exp : undefined;

  // Recompute lottery bucket assignment for this session — pure function,
  // same inputs as the lib.
  const lotteryBucket = sessionId
    ? (defaultLotteryCheck(env.WAYPOINT_SECRET)(sessionId, LOTTERY_CHANCE) ? "lucky" : "unlucky")
    : null;

  return Response.json({
    phase,
    sessionId,
    entryAt: decoded.entryAt,
    exitAt,
    currentSlot: String(currentSlot),
    slots,
    lottery: {
      bucket: lotteryBucket,
      chance: LOTTERY_CHANCE,
      luckyMin: LUCKY_WAIT_SECONDS.min,
      luckyMax: LUCKY_WAIT_SECONDS.max,
    },
    config: {
      waitMin: WAIT_SECONDS.min,
      waitMax: WAIT_SECONDS.max,
      activeSeconds: ACTIVE_SECONDS,
      perSlot: ADMISSION_PER_SLOT,
      slotSeconds: SLOT_SECONDS,
    },
  });
}

function serveReset(): Response {
  const headers = new Headers();
  headers.append("Set-Cookie", clearCookieHeader(COOKIE_NAME));
  headers.append("Set-Cookie", clearCookieHeader(SESSION_COOKIE));
  headers.set("Location", DEMO_PATH);
  return new Response(null, { status: 302, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === DEMO_PATH) {
      return new Response(demoPanelHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (path === STATE_PATH) {
      return serveState(request, env);
    }
    if (path === RESET_PATH) {
      return serveReset();
    }
    if (path === WAITING_PATH) {
      return serveWaitingPage(request, env);
    }

    // Everything else hits the gate. The "origin" the gate protects is
    // the mock product page below.
    let sessionId = readCookie(request, SESSION_COOKIE);
    let setSessionHeader: string | undefined;
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      setSessionHeader = setCookieHeader(SESSION_COOKIE, sessionId);
    }

    const room = makeRoom(env);
    const verdict = await room.evaluate({
      cookie: readCookie(request, COOKIE_NAME),
      bindings: { sessionId },
    });

    const headers = new Headers();
    if (setSessionHeader) headers.append("Set-Cookie", setSessionHeader);

    if (verdict.action === "pass") {
      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(mockOriginHtml(), { headers });
    }

    if (verdict.action === "admit") {
      headers.append("Set-Cookie", setCookieHeader(COOKIE_NAME, verdict.cookie));
      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(mockOriginHtml(), { headers });
    }

    headers.append("Set-Cookie", setCookieHeader(COOKIE_NAME, verdict.cookie));
    const target = new URL(WAITING_PATH, request.url);
    target.searchParams.set("returnTo", request.url);
    target.searchParams.set("t", String(verdict.entryAt));
    headers.set("Location", target.toString());
    return new Response(null, { status: 302, headers });
  },
};
