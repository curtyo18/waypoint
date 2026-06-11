/**
 * Minimal Buffer shim for the waypass browser demo.
 *
 * waypass src/ uses Buffer for:
 *   1. Buffer.from(string, "utf8")             → encode string to bytes
 *   2. Buffer.from(string, "base64url")        → decode base64url string to bytes
 *   3. Buffer.from(Uint8Array)                 → wrap bytes
 *   4. result.toString("utf8")                 → decode bytes to string
 *   5. result.toString("base64url")            → encode bytes to base64url string
 *   6. Used as Uint8Array in timingSafeEqual
 *
 * This is a demo-only shim. It does not implement the full Node.js Buffer API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder("utf-8");

// We deliberately avoid extending Uint8Array's static side to prevent TS
// conflicts with Uint8Array.from's overloads. Instead we build a plain object
// that satisfies the subset the waypass src/ actually uses.

interface BrowserBuffer extends Uint8Array {
  toString(encoding?: "utf8" | "utf-8" | "base64url" | "hex" | "base64"): string;
}

function makeBuffer(bytes: Uint8Array): BrowserBuffer {
  const buf = bytes as BrowserBuffer;
  buf.toString = function (
    encoding: "utf8" | "utf-8" | "base64url" | "hex" | "base64" = "utf8",
  ): string {
    if (encoding === "utf8" || encoding === "utf-8") {
      return utf8Dec.decode(this);
    }
    if (encoding === "hex") {
      return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    let bin = "";
    for (const b of this) bin += String.fromCharCode(b);
    const b64 = btoa(bin);
    if (encoding === "base64url") {
      return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    return b64;
  };
  return buf;
}

const BufferShim = {
  from(
    data: string | Uint8Array | ArrayBuffer | number[] | ArrayLike<number>,
    encoding: "utf8" | "utf-8" | "base64url" | "hex" | "base64" = "utf8",
  ): BrowserBuffer {
    if (data instanceof Uint8Array) {
      return makeBuffer(new Uint8Array(data));
    }
    if (data instanceof ArrayBuffer) {
      return makeBuffer(new Uint8Array(data));
    }
    if (Array.isArray(data)) {
      return makeBuffer(new Uint8Array(data as number[]));
    }
    if (typeof data !== "string") {
      // ArrayLike<number> fallback
      return makeBuffer(new Uint8Array(Array.from(data as ArrayLike<number>)));
    }
    // string
    if (encoding === "utf8" || encoding === "utf-8") {
      return makeBuffer(utf8Enc.encode(data));
    }
    if (encoding === "hex") {
      const bytes = new Uint8Array(data.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
      }
      return makeBuffer(bytes);
    }
    // base64 / base64url
    const b64 =
      encoding === "base64url"
        ? data.replace(/-/g, "+").replace(/_/g, "/")
        : data;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return makeBuffer(bytes);
  },

  isBuffer(obj: unknown): obj is BrowserBuffer {
    return obj instanceof Uint8Array;
  },

  alloc(size: number, fill = 0): BrowserBuffer {
    const buf = new Uint8Array(size);
    if (fill !== 0) buf.fill(fill);
    return makeBuffer(buf);
  },

  concat(list: Uint8Array[], totalLength?: number): BrowserBuffer {
    const len = totalLength ?? list.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const b of list) {
      out.set(b, off);
      off += b.length;
    }
    return makeBuffer(out);
  },
};

export { BufferShim as Buffer };

// Expose as global so Node-style implicit `Buffer.from(...)` calls inside the
// bundled src/ work without an import statement.
declare global {
  // eslint-disable-next-line no-var
  var Buffer: typeof BufferShim;
}

(globalThis as any).Buffer = BufferShim;
