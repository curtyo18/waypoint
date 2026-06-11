/**
 * Browser stand-in for the `node:crypto` surface that src/ imports. Substituted
 * by esbuild `alias` in web/esbuild.config.mjs; the server never loads this file.
 *
 * timingSafeEqual here is NOT timing-safe — this shim only ever runs in a
 * single-user demo page where there is no attacker to time anything. The
 * webhook-verification code paths that call it are bundled but never invoked.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0

function sha256Bytes(message: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const bitLen = message.length * 8
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6)
  padded.set(message)
  padded[message.length] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000))
  dv.setUint32(padded.length - 4, bitLen >>> 0)

  const w = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let a = H[0]!,
      b = H[1]!,
      c = H[2]!,
      d = H[3]!,
      e = H[4]!,
      f = H[5]!,
      g = H[6]!,
      h = H[7]!
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    H[0] = (H[0]! + a) >>> 0
    H[1] = (H[1]! + b) >>> 0
    H[2] = (H[2]! + c) >>> 0
    H[3] = (H[3]! + d) >>> 0
    H[4] = (H[4]! + e) >>> 0
    H[5] = (H[5]! + f) >>> 0
    H[6] = (H[6]! + g) >>> 0
    H[7] = (H[7]! + h) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i]!)
  return out
}

function hmacSha256Bytes(key: Uint8Array, message: Uint8Array): Uint8Array {
  const BLOCK = 64
  const k = key.length > BLOCK ? sha256Bytes(key) : key
  const ipad = new Uint8Array(BLOCK)
  const opad = new Uint8Array(BLOCK)
  ipad.set(k)
  opad.set(k)
  for (let i = 0; i < BLOCK; i++) {
    ipad[i] = ipad[i]! ^ 0x36
    opad[i] = opad[i]! ^ 0x5c
  }
  return sha256Bytes(concatBytes([opad, sha256Bytes(concatBytes([ipad, message]))]))
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

const toBytes = (data: string | Uint8Array): Uint8Array =>
  typeof data === 'string' ? utf8(data) : data

class Sha256Hash {
  private readonly chunks: Uint8Array[] = []
  update(data: string | Uint8Array): this {
    this.chunks.push(toBytes(data))
    return this
  }
  digest(encoding: 'hex'): string {
    void encoding
    return toHex(sha256Bytes(concatBytes(this.chunks)))
  }
}

class Sha256Hmac {
  private readonly chunks: Uint8Array[] = []
  constructor(private readonly key: Uint8Array) {}
  update(data: string | Uint8Array): this {
    this.chunks.push(toBytes(data))
    return this
  }
  digest(): Uint8Array
  digest(encoding: 'hex' | 'base64' | 'base64url'): string
  digest(encoding?: 'hex' | 'base64' | 'base64url'): string | Uint8Array {
    const mac = hmacSha256Bytes(this.key, concatBytes(this.chunks))
    // node:crypto's digest() with no encoding returns a Buffer of raw bytes.
    // waypoint's jitter.ts calls .digest() argless and indexes mac[i]; without
    // this branch the shim returned a base64 string, jitter read characters
    // instead of bytes, and produced NaN waits (entryAt -> null -> malformed).
    if (encoding === undefined) return mac
    if (encoding === 'hex') return toHex(mac)
    const b64 = toBase64(mac)
    if (encoding === 'base64url') return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return b64
  }
}

export function createHash(algorithm: string): Sha256Hash {
  if (algorithm !== 'sha256')
    throw new Error(`demo crypto shim only supports sha256, got "${algorithm}"`)
  return new Sha256Hash()
}

export function createHmac(algorithm: string, key: string | Uint8Array): Sha256Hmac {
  if (algorithm !== 'sha256')
    throw new Error(`demo crypto shim only supports sha256, got "${algorithm}"`)
  return new Sha256Hmac(toBytes(key))
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID()
}

export function randomInt(minOrMax: number, max?: number): number {
  const lo = max === undefined ? 0 : minOrMax
  const hi = max === undefined ? minOrMax : max
  const range = hi - lo
  const buf = new Uint32Array(1)
  // rejection sampling to avoid modulo bias
  const limit = Math.floor(0x100000000 / range) * range
  let v: number
  do {
    globalThis.crypto.getRandomValues(buf)
    v = buf[0]!
  } while (v >= limit)
  return lo + (v % range)
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length')
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/**
 * waypass calls randomBytes(16).toString("hex") for the token jti.
 * Browser-only: back it with the platform CSPRNG. Throw loudly rather than
 * fall back to weak bytes — there is no safe degraded mode.
 */
export function randomBytes(size: number): {
  toString(enc: "hex" | "base64url"): string;
} {
  const g = globalThis as { crypto?: Crypto };
  if (!g.crypto?.getRandomValues) {
    throw new Error("node-crypto shim: no Web Crypto available for randomBytes");
  }
  const bytes = new Uint8Array(size);
  g.crypto.getRandomValues(bytes);
  return {
    toString(enc) {
      if (enc === "hex") {
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      }
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
  };
}
