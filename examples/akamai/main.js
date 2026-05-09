import { Cookies, SetCookie } from "cookies";
import { create as createToken, verify as verifyToken } from "./wire.js";
import { EdgeKVAdmissionStore } from "./admission-store-edgekv.js";

// Operator config — in a real EdgeWorker these would come from a Property
// Manager variable or a bundled config. Hard-coded here for clarity.
const SECRET = "change-me-in-production";
const PURPOSE = "waypoint";
const COOKIE_NAME = "waypoint";
const SESSION_COOKIE = "wp_sid";
const WAIT_MIN = 30;
const WAIT_MAX = 120;
const ACTIVE_SECONDS = 600;
const GRACE = 60;
const TTL_SECONDS = WAIT_MAX + ACTIVE_SECONDS + GRACE;
const ADMISSION_PER_SLOT = 100;
const SLOT_SECONDS = 10;
const WAITING_PAGE = "/__waiting";

const store = new EdgeKVAdmissionStore();

function readCookie(request, name) {
  const cookies = new Cookies(request.getHeader("Cookie") || []);
  return cookies.get(name);
}

function setCookie(response, name, value) {
  const sc = new SetCookie();
  sc.name = name;
  sc.value = value;
  sc.httpOnly = true;
  sc.secure = true;
  sc.sameSite = "Lax";
  sc.path = "/";
  response.setHeader("Set-Cookie", sc.toHeader());
}

function newSessionId() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let ix = 0; ix < buf.length; ix++) {
    hex += buf[ix].toString(16).padStart(2, "0");
  }
  return hex;
}

// Daily-rotating deterministic jitter — same idea as the default
// Node-side jitter, reimplemented with SubtleCrypto.
async function jitter(secret, sessionId, min, max) {
  if (max === min) return min;
  const dailySalt = Math.floor(Date.now() / 1000 / 86400);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(`${sessionId}:${dailySalt}`)),
  );
  let acc = 0;
  for (let ix = 0; ix < 6; ix++) acc = acc * 256 + mac[ix];
  const span = max - min + 1;
  return min + (acc % span);
}

export async function onClientRequest(request) {
  let sessionId = readCookie(request, SESSION_COOKIE);
  let needSetSession = false;
  if (!sessionId) {
    sessionId = newSessionId();
    needSetSession = true;
  }

  const cookie = readCookie(request, COOKIE_NAME);
  const bindings = { sessionId };
  const verified = cookie
    ? await verifyToken(cookie, bindings, SECRET, PURPOSE)
    : { ok: false, reason: "missing" };

  let action = "wait";
  let entryAt;
  let nextCookie;

  if (verified.ok) {
    const data = verified.payload && verified.payload.data;
    const state = data && data.state;
    if (state === "active") {
      action = "pass";
    } else if (state === "waiting") {
      const now = Math.floor(Date.now() / 1000);
      if (now < data.entryAt) {
        action = "wait";
        entryAt = data.entryAt;
        nextCookie = cookie;
      } else {
        // Past entryAt — try to admit, with the sharded EdgeKV cap.
        const slotIdx = Math.floor(now / SLOT_SECONDS);
        const slot = String(slotIdx);
        let admitted;
        try {
          admitted = await store.tryAdmit(slot, ADMISSION_PER_SLOT, sessionId);
        } catch (_e) {
          // Fail-open: favour availability when EdgeKV is unhappy.
          admitted = true;
        }
        if (admitted) {
          action = "admit";
          nextCookie = await createToken(bindings, { state: "active" }, SECRET, TTL_SECONDS, PURPOSE);
        } else {
          action = "wait";
          entryAt = (slotIdx + 1) * SLOT_SECONDS;
          nextCookie = await createToken(
            bindings,
            { state: "waiting", entryAt },
            SECRET,
            TTL_SECONDS,
            PURPOSE,
          );
        }
      }
    }
  }

  if (action === "wait" && !verified.ok) {
    // Fresh visitor or stale cookie — issue a new waiting cookie.
    const wait = await jitter(SECRET, sessionId, WAIT_MIN, WAIT_MAX);
    entryAt = Math.floor(Date.now() / 1000) + wait;
    nextCookie = await createToken(
      bindings,
      { state: "waiting", entryAt },
      SECRET,
      TTL_SECONDS,
      PURPOSE,
    );
  }

  if (action === "pass") {
    if (needSetSession) setCookie(request, SESSION_COOKIE, sessionId);
    return; // Forward to origin unchanged.
  }

  if (action === "admit") {
    if (needSetSession) setCookie(request, SESSION_COOKIE, sessionId);
    setCookie(request, COOKIE_NAME, nextCookie);
    return; // Forward to origin with the active cookie set.
  }

  // wait — short-circuit to the waiting page.
  if (needSetSession) setCookie(request, SESSION_COOKIE, sessionId);
  setCookie(request, COOKIE_NAME, nextCookie);
  const original = `${request.scheme}://${request.host}${request.url}`;
  const waitingUrl = `${WAITING_PAGE}?returnTo=${encodeURIComponent(original)}&t=${entryAt}`;
  request.respondWith(302, { Location: [waitingUrl] }, "");
}
