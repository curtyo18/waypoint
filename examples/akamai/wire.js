/**
 * waypoint/waypass cookie wire protocol — EdgeWorker reimplementation.
 *
 * Akamai EdgeWorker has no Node.js compatibility shim, so we cannot import
 * waypass directly. This file mirrors the wire format byte-for-byte using
 * SubtleCrypto so a token issued here would parse the same way as one
 * issued by waypass v0.0.2.
 *
 * Format: `v1.<base64url-payload>.<base64url-sig>`
 *   - payload is JSON: { version, purpose, bindings, data?, iat, exp, jti }
 *   - bindings keys are sorted lexicographically before signing — same
 *     canonicalisation as waypass.
 *   - sig is HMAC-SHA256(secret, "v1." + base64url(payload)) — the prefix
 *     is part of the signed input so a token can't be downgraded by
 *     swapping versions.
 */

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();
const VERSION_TAG = "v1";

function base64UrlEncode(bytes) {
  let bin = "";
  for (let ix = 0; ix < bytes.length; ix++) {
    bin += String.fromCharCode(bytes[ix]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let ix = 0; ix < bin.length; ix++) {
    out[ix] = bin.charCodeAt(ix);
  }
  return out;
}

function sortedJSON(value) {
  // JSON with stable key ordering — we only need it for the `bindings`
  // object since that's what waypass canonicalises.
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const keys = Object.keys(val).sort();
      const reordered = {};
      for (const key of keys) reordered[key] = val[key];
      return reordered;
    }
    return val;
  });
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    TEXT_ENC.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function constantTimeEqualBytes(arrA, arrB) {
  if (arrA.length !== arrB.length) return false;
  let diff = 0;
  for (let ix = 0; ix < arrA.length; ix++) diff |= arrA[ix] ^ arrB[ix];
  return diff === 0;
}

function randomJti() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export async function create(bindings, data, secret, ttlSeconds, purpose) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    version: 1,
    purpose,
    bindings,
    iat: now,
    exp: now + ttlSeconds,
    jti: randomJti(),
  };
  if (data !== undefined) payload.data = data;

  // Canonicalise bindings before signing — must match waypass.
  const canon = {
    version: payload.version,
    purpose: payload.purpose,
    bindings: JSON.parse(sortedJSON(bindings)),
    iat: payload.iat,
    exp: payload.exp,
    jti: payload.jti,
  };
  if (data !== undefined) canon.data = data;
  const payloadJson = JSON.stringify(canon);
  const payloadB64 = base64UrlEncode(TEXT_ENC.encode(payloadJson));
  const signingInput = `${VERSION_TAG}.${payloadB64}`;
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, TEXT_ENC.encode(signingInput));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));
  return `${signingInput}.${sigB64}`;
}

export async function verify(cookie, bindings, secret, purpose) {
  if (typeof cookie !== "string") return { ok: false, reason: "missing" };
  const parts = cookie.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION_TAG) {
    return { ok: false, reason: "malformed" };
  }
  const [, payloadB64, sigB64] = parts;
  const signingInput = `${VERSION_TAG}.${payloadB64}`;

  const key = await importKey(secret);
  const expected = await crypto.subtle.sign("HMAC", key, TEXT_ENC.encode(signingInput));
  const expectedBytes = new Uint8Array(expected);
  let presented;
  try {
    presented = base64UrlDecode(sigB64);
  } catch (_e) {
    return { ok: false, reason: "malformed" };
  }
  if (!constantTimeEqualBytes(expectedBytes, presented)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload;
  try {
    payload = JSON.parse(TEXT_DEC.decode(base64UrlDecode(payloadB64)));
  } catch (_e) {
    return { ok: false, reason: "malformed" };
  }

  if (payload.purpose !== purpose) return { ok: false, reason: "purpose-mismatch" };
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || now >= payload.exp) {
    return { ok: false, reason: "expired" };
  }

  const presentedBindings = payload.bindings || {};
  for (const key2 of Object.keys(bindings)) {
    if (presentedBindings[key2] !== bindings[key2]) {
      return { ok: false, reason: "bindings-mismatch" };
    }
  }
  for (const key2 of Object.keys(presentedBindings)) {
    if (bindings[key2] === undefined) {
      return { ok: false, reason: "bindings-mismatch" };
    }
  }

  return { ok: true, payload };
}
