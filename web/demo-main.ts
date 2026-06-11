import { Waypoint, InMemoryAdmissionStore, defaultLotteryCheck } from "../src/index.js";

// ---- Demo configuration (mirrors examples/cloudflare/worker.ts, with
// demo-friendly waits so the countdowns are watchable in a single sitting). ----
const SECRET = "demo-secret";
const WAIT_SECONDS = { min: 8, max: 20 };
const ACTIVE_SECONDS = 60;
const LUCKY_CHANCE = 0.3;
const LUCKY_WAIT_SECONDS = { min: 1, max: 4 };

const room = new Waypoint<Record<string, string>>({
  secret: SECRET,
  waitSeconds: WAIT_SECONDS,
  activeSeconds: ACTIVE_SECONDS,
  lottery: { luckyChance: LUCKY_CHANCE, luckyWaitSeconds: LUCKY_WAIT_SECONDS },
});
const isLucky = defaultLotteryCheck(SECRET);

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const el = (id: string) => document.getElementById(id)!;
const nowSec = () => Math.floor(Date.now() / 1000);

function fmtRel(seconds: number): string {
  const abs = Math.abs(seconds);
  return (seconds < 0 ? "-" : "") + Math.floor(abs / 60) + "m " + (abs % 60) + "s";
}
const pill = (s: string) => `<span class="pill pill-${s}">${s}</span>`;
const clockTime = (unix: number) => new Date(unix * 1000).toLocaleTimeString() + " (" + unix + ")";

// Decode the signed waypoint cookie client-side — same as the worker's
// decodeWaypointCookie: the token is `v1.<base64url-payload>.<sig>`.
function decodeCookie(value: string | undefined): { state?: string; entryAt?: number; exitAt?: number } {
  if (!value) return {};
  const parts = value.split(".");
  if (parts.length !== 3) return {};
  try {
    const json = atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"));
    const data = (JSON.parse(json) as { data?: { state?: string; entryAt?: number; exitAt?: number } }).data;
    return { state: data?.state, entryAt: data?.entryAt, exitAt: data?.exitAt };
  } catch {
    return {};
  }
}

// ---- Per-session state (the worker keeps these in cookies; we keep them here). ----
let sessionId = "";
let cookie: string | undefined;
let visited = false;

function reroll() {
  sessionId = crypto.randomUUID();
  cookie = undefined;
  visited = false;
  el("siteView").innerHTML =
    `<p>You haven't entered yet.</p><p class="help">Click <strong>Visit the gated site</strong> to hit the gate.</p>`;
}

function renderWaiting(entryAt: number) {
  const remaining = Math.max(0, entryAt - nowSec());
  const bucket = isLucky(sessionId, LUCKY_CHANCE) ? "lucky" : "unlucky";
  el("siteView").innerHTML =
    `<h3>You're in line</h3>` +
    `<p>We're letting people in a few at a time so the site stays fast for everyone. You'll go through automatically.</p>` +
    `<div class="countdown">${fmtRel(remaining)}</div>` +
    `<p class="help">You drew the ${pill(bucket)} bucket.</p>`;
}

function renderShop() {
  el("siteView").innerHTML =
    `<span class="badge">You're in</span>` +
    `<h3>Limited Edition Widget</h3>` +
    `<p class="price">£24.99</p>` +
    `<p>You waited in line and waypoint let you through. This is the protected origin behind the gate — your active cookie keeps you in for the configured window.</p>` +
    `<p><button>Add to bag</button></p>`;
}

// One evaluate() per tick, exactly like the worker re-evaluating per request:
// waiting returns the same cookie until entryAt, then admit issues an active
// cookie; once the active window lapses, the gate re-queues.
async function gate() {
  const verdict = await room.evaluate({ cookie, bindings: { sessionId } });
  if ("cookie" in verdict && verdict.cookie) cookie = verdict.cookie;
  if (verdict.action === "wait") renderWaiting(verdict.entryAt);
  else renderShop();
}

function refreshInspector() {
  const d = decodeCookie(cookie);
  const phase = d.state ?? "fresh";
  el("phase").innerHTML = pill(phase);
  el("bucket").innerHTML = visited ? pill(isLucky(sessionId, LUCKY_CHANCE) ? "lucky" : "unlucky") : "—";
  el("sessionId").textContent = visited ? sessionId : "—";
  el("entryAt").textContent = d.entryAt ? clockTime(d.entryAt) : "—";
  el("activeExp").textContent = d.exitAt ? clockTime(d.exitAt) : "—";

  const cd = el("countdown");
  if (phase === "waiting" && d.entryAt) cd.textContent = "admit in " + fmtRel(d.entryAt - nowSec());
  else if (phase === "active" && d.exitAt) cd.textContent = "expires in " + fmtRel(d.exitAt - nowSec());
  else cd.textContent = "—";
}

async function tick() {
  if (visited) await gate();
  refreshInspector();
}

el("visit").addEventListener("click", async () => {
  if (!sessionId) sessionId = crypto.randomUUID();
  visited = true;
  await gate();
  refreshInspector();
});
el("reset").addEventListener("click", () => {
  reroll();
  refreshInspector();
});

// ---- Configuration panel ----
el("cfg-wait").textContent = `${WAIT_SECONDS.min}...${WAIT_SECONDS.max} s`;
el("cfg-active").textContent = `${ACTIVE_SECONDS} s`;
el("cfg-luckychance").textContent = `${(LUCKY_CHANCE * 100).toFixed(0)}%`;
el("cfg-luckywait").textContent = `${LUCKY_WAIT_SECONDS.min}...${LUCKY_WAIT_SECONDS.max} s`;

// ---- Admission-cap rush (separate scenario) ----
el("rush").addEventListener("click", async () => {
  const store = new InMemoryAdmissionStore();
  const capped = new Waypoint({
    secret: SECRET,
    waitSeconds: { min: 0, max: 0 },
    activeSeconds: 6,
    admissionCap: {
      perSlot: Number($("perSlot").value) || 2,
      slotSeconds: Number($("slot").value) || 4,
      store,
    },
  });
  const n = Number($("visitors").value) || 6;
  const lines: string[] = [];
  let admitted = 0;
  for (let i = 0; i < n; i++) {
    const first = await capped.evaluate({ cookie: undefined, bindings: { sessionId: `v${i}` } });
    const c = "cookie" in first ? first.cookie : undefined;
    const v = await capped.evaluate({ cookie: c, bindings: { sessionId: `v${i}` } });
    if (v.action === "admit") admitted++;
    const bumped = v.action === "wait" ? `  → bumped to next slot (entryAt ${(v as { entryAt: number }).entryAt})` : "";
    lines.push(`visitor ${i}: ${v.action}${bumped}`);
  }
  el("cap").textContent = lines.join("\n") + `\n\n${admitted}/${n} admitted this slot — the rest spread to later slots.`;
});

// ---- Boot ----
reroll();
refreshInspector();
setInterval(tick, 1000);
