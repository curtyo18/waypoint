// The EdgeKV module is an Akamai EdgeWorker built-in; imported by name,
// not a relative path. See https://techdocs.akamai.com/edgekv/docs.
import { EdgeKV } from "edgekv.js";

/**
 * Sharded EdgeKV admission store.
 *
 * EdgeKV is eventually consistent across the global PoP fleet, with a
 * documented per-key sustained write ceiling of roughly 1 write/second.
 * Two implications drive this design:
 *
 *   1. Concurrent admitters at the slot boundary may both observe the
 *      counter under-cap, both increment, and both be admitted —
 *      bounded overshoot per slot, capped by the EdgeKV consistency
 *      window.
 *
 *   2. Routing every admission for a slot through a single EdgeKV key
 *      would push us past the per-key write ceiling on a busy room.
 *      Sharding the counter into N independent keys spreads writes and
 *      keeps each shard well under the limit.
 *
 * We hash sessionId → shard, then enforce a per-shard cap of
 * ceil(globalCap / SHARD_COUNT). Visitors stay on the same shard for
 * their whole session, so the cap behaves as a per-shard rate limit
 * rather than a true global one. Pick SHARD_COUNT and perSlot to match
 * how much overshoot you can absorb.
 */

const SHARD_COUNT = 10;
const NAMESPACE = "waypoint";
const GROUP = "admissions";

function hashShard(sessionId) {
  // FNV-1a 32-bit. Cheap and uniform enough for shard selection — this is
  // not a security boundary.
  let hash = 0x811c9dc5;
  for (let ix = 0; ix < sessionId.length; ix++) {
    hash ^= sessionId.charCodeAt(ix);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash % SHARD_COUNT;
}

export class EdgeKVAdmissionStore {
  constructor() {
    this.kv = new EdgeKV({ namespace: NAMESPACE, group: GROUP });
  }

  /**
   * Note the extra `sessionId` argument. The standard waypoint
   * `AdmissionStore.tryAdmit(slot, cap)` signature can't carry it, so the
   * EdgeWorker entry point passes it through explicitly. Document this
   * divergence wherever this store is wired up.
   */
  async tryAdmit(slot, cap, sessionId) {
    const shard = hashShard(sessionId);
    const key = `slot:${slot}:s${shard}`;
    const perShardCap = Math.ceil(cap / SHARD_COUNT);

    let current = 0;
    try {
      const got = await this.kv.getJson({ item: key });
      current = (got && typeof got.count === "number") ? got.count : 0;
    } catch (_e) {
      // Treat as zero — first write to a never-set key throws on some
      // EdgeKV configurations.
      current = 0;
    }

    if (current >= perShardCap) {
      return false;
    }
    await this.kv.putJson({ item: key, value: { count: current + 1 } });
    return true;
  }
}
