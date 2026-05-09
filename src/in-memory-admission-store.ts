import type { AdmissionStore } from "./types.js";

/**
 * Process-local admission store, intended for tests and single-process
 * dev runs. Real deployments need an out-of-process store (Cloudflare
 * Durable Object, Akamai EdgeKV, Redis, etc.) — see examples/.
 */
export class InMemoryAdmissionStore implements AdmissionStore {
  private readonly counts = new Map<string, number>();
  private readonly forcedErrors = new Set<string>();

  public async tryAdmit(slot: string, cap: number): Promise<boolean> {
    if (this.forcedErrors.has(slot)) {
      throw new Error(`forced error for slot ${slot}`);
    }
    const current = this.counts.get(slot) ?? 0;
    if (current >= cap) {
      return false;
    }
    this.counts.set(slot, current + 1);
    return true;
  }

  public count(slot: string): number {
    return this.counts.get(slot) ?? 0;
  }

  public triggerError(slot: string): void {
    this.forcedErrors.add(slot);
  }

  public clearError(slot: string): void {
    this.forcedErrors.delete(slot);
  }
}
