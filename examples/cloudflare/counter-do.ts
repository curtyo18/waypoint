/**
 * Reference code for the optional admission cap — NOT used by the default
 * demo. The default demo runs splay buffer + bimodal lottery only.
 *
 * Durable Object that holds atomic per-slot counters.
 *
 * `tryAdmit` is the only operation: read current count, compare to cap,
 * conditionally increment. The DO's single-threaded execution model gives
 * us atomicity for free — no compare-and-swap dance.
 *
 * To enable the cap in this demo, see the README ("Enabling the optional
 * admission cap").
 */
export class CounterDO {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/tryAdmit") {
      const slot = url.searchParams.get("slot");
      const capRaw = url.searchParams.get("cap");
      if (!slot || !capRaw) {
        return new Response("bad request", { status: 400 });
      }
      const cap = parseInt(capRaw, 10);
      if (!Number.isFinite(cap) || cap <= 0) {
        return new Response("bad request", { status: 400 });
      }

      const current = ((await this.state.storage.get<number>(slot)) ?? 0);
      if (current >= cap) {
        return Response.json({ admitted: false, count: current });
      }
      const next = current + 1;
      await this.state.storage.put(slot, next);
      return Response.json({ admitted: true, count: next });
    }

    if (url.pathname === "/peek") {
      // Read-only — used by the demo panel to display current admissions.
      // Returns counts for the requested slots (comma-separated) without
      // touching them.
      const slots = (url.searchParams.get("slots") ?? "").split(",").filter(Boolean);
      const counts: Record<string, number> = {};
      for (const slot of slots) {
        counts[slot] = (await this.state.storage.get<number>(slot)) ?? 0;
      }
      return Response.json({ counts });
    }

    return new Response("not found", { status: 404 });
  }
}
