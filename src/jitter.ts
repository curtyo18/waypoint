import { createHmac } from "node:crypto";

/**
 * Default deterministic jitter for waypoint.
 *
 * Returns an integer in [min, max] derived from
 *   HMAC-SHA256(secret, sessionId + ":" + floor(now/86400))
 *
 * The daily salt rotates the mapping every UTC day so that a session that
 * keeps reloading can't learn its `entryAt` and time the next visit.
 *
 * Pure function: same (secret, sessionId, day, min, max) → same output.
 * Reload-stable within the day, which is the property the brief asks for.
 */
export function defaultJitter(secret: string): (sessionId: string, min: number, max: number) => number {
  return (sessionId: string, min: number, max: number): number => {
    if (max < min) {
      throw new Error("waypoint: waitSeconds.max must be >= waitSeconds.min");
    }
    if (max === min) {
      return min;
    }
    const dailySalt = Math.floor(Date.now() / 1000 / 86400);
    const mac = createHmac("sha256", secret)
      .update(`${sessionId}:${dailySalt}`)
      .digest();
    // Take the high 6 bytes as a 48-bit unsigned integer; well under
    // Number.MAX_SAFE_INTEGER and gives plenty of bits for any sane range.
    let acc = 0;
    for (let ix = 0; ix < 6; ix++) {
      acc = acc * 256 + mac[ix]!;
    }
    const span = max - min + 1;
    return min + (acc % span);
  };
}
