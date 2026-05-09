import type { AdmissionStore } from "waypoint";

/**
 * Reference code for the optional admission cap — NOT used by the default
 * demo. The default demo runs splay buffer + bimodal lottery only.
 *
 * AdmissionStore backed by a Durable Object that owns the per-slot
 * counters. Every Worker isolate routes its `tryAdmit` calls to the same
 * DO instance via a fixed name, so all admissions for a given slot
 * serialise through one place.
 *
 * Trade-off: routing through a single DO instance for every admission is
 * the simplest correct design but caps your global admission throughput at
 * ~1 DO. For very large rooms, shard by `hash(sessionId) % N` and use
 * per-shard caps — the same pattern as the Akamai example.
 */
export type AdmissionStoreEnv = {
  COUNTER: DurableObjectNamespace;
};

export class DurableObjectAdmissionStore implements AdmissionStore {
  private readonly env: AdmissionStoreEnv;
  private readonly instanceName: string;

  constructor(env: AdmissionStoreEnv, instanceName = "waypoint-admissions") {
    this.env = env;
    this.instanceName = instanceName;
  }

  public async tryAdmit(slot: string, cap: number): Promise<boolean> {
    const id = this.env.COUNTER.idFromName(this.instanceName);
    const stub = this.env.COUNTER.get(id);
    const url = `https://counter/tryAdmit?slot=${encodeURIComponent(slot)}&cap=${cap}`;
    const res = await stub.fetch(url);
    if (!res.ok) {
      throw new Error(`counter DO returned ${res.status}`);
    }
    const body = (await res.json()) as { admitted: boolean };
    return body.admitted === true;
  }
}
