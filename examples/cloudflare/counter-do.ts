/**
 * Durable Object that holds atomic per-slot counters.
 *
 * `tryAdmit` is the only operation: read current count, compare to cap,
 * conditionally increment. The DO's single-threaded execution model gives
 * us atomicity for free — no compare-and-swap dance.
 */
export class CounterDO {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/tryAdmit") {
      return new Response("not found", { status: 404 });
    }
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
}
