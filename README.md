# waypoint

Stateless waiting-room library: signed cookies + edge-worker gate + static page. Sister project to [waypass](https://github.com/curtyo18/waypass).

waypoint smooths a thundering-herd arrival into a steady stream by handing each visitor a deterministic randomised wait — a *splay buffer* — held entirely in a signed cookie. No queue, no per-session state on your origin, no Redis.

You'd reach for waypoint when you have a known traffic spike (a sale, a ticket drop, an embargo lift) and want to bound concurrent arrivals at the origin without standing up queue infrastructure.

## Quick start

```ts
import { Waypoint } from "waypoint";

const room = new Waypoint<{ shop: string }>({
  secret: process.env.WAYPOINT_SECRET!,
  waitSeconds: { min: 30, max: 120 },
  activeSeconds: 600,
});

// In your request handler:
async function handle(request: Request, sessionId: string): Promise<Response> {
  const verdict = await room.evaluate({
    cookie: readCookie(request, "waypoint"),
    bindings: { sessionId, shop: "demo" },
  });

  if (verdict.action === "pass") {
    return forwardToOrigin(request);
  }

  if (verdict.action === "admit") {
    const res = await forwardToOrigin(request);
    res.headers.append(
      "Set-Cookie",
      `waypoint=${verdict.cookie}; HttpOnly; Secure; SameSite=Lax; Path=/`,
    );
    return res;
  }

  // wait
  const headers = new Headers({
    "Set-Cookie": `waypoint=${verdict.cookie}; HttpOnly; Secure; SameSite=Lax; Path=/`,
    Location: `/__waiting?returnTo=${encodeURIComponent(request.url)}&t=${verdict.entryAt}`,
  });
  return new Response(null, { status: 302, headers });
}
```

The first visit issues a `waiting` cookie and redirects to the static waiting page. The page counts down to `entryAt`, then sends the visitor back. The next request arrives past `entryAt` and gets re-signed as `active`.

## Three modes — pick what fits

waypoint exposes one core algorithm (deterministic splay buffer) with two optional add-ons. Pick the simplest mode that matches your needs.

### 1. Plain splay (the default)

Every visitor gets a uniformly-random wait inside `waitSeconds`. Single countdown, single admission. No infrastructure beyond the worker. Best for small/medium deployments and predictable bursts.

```ts
new Waypoint({
  secret,
  waitSeconds: { min: 60, max: 600 },   // 1–10 min spread
  activeSeconds: 1800,
});
```

### 2. Bimodal lottery (recommended for production)

Lucky and unlucky buckets, deterministically assigned per session. A small fraction of visitors land in the lucky bucket and get a short wait; the rest get the regular wait. Same UX as plain splay (one countdown each) — just a bimodal distribution instead of uniform.

The lottery is *one-shot*: assigned at issuance, no per-attempt retries, no extra gate load. Better-feeling UX for real users (some get fast-tracked, the rest still get a definite admission time) without giving up the stateless property.

```ts
new Waypoint({
  secret,
  waitSeconds: { min: 60, max: 600 },           // unlucky bucket
  activeSeconds: 1800,
  lottery: {
    luckyChance: 0.05,                           // 5% of arrivals
    luckyWaitSeconds: { min: 0, max: 30 },       // fast-track
  },
});
```

Recommended default for any deployment that's user-facing during a sale or drop. The bimodal feel ("most people wait, a lucky few skip the line") matches real-world expectations for a queue.

### 3. + Admission cap (optional, for hard ceilings)

Layer this on top of either of the above when your origin has a hard rate ceiling that *must not* be exceeded. The cap is per-slot, atomic, requires shared state (a Durable Object, EdgeKV, or any other atomic counter). Costs operational complexity for the precision.

```ts
new Waypoint({
  secret,
  waitSeconds: { min: 60, max: 600 },
  activeSeconds: 1800,
  admissionCap: {
    perSlot: 12000,
    slotSeconds: 60,
    store: yourAdmissionStore,                   // BYO atomic counter
  },
});
```

Most operators don't need this. Plain splay or bimodal lottery, sized correctly, holds traffic under origin capacity by spreading arrivals over time. The cap exists for when "definitely below N admissions per second, no exceptions" is a hard requirement (legal, infra, contractual).

## Sizing your deployment

The maths for any waypoint-protected origin is the same: **drain time = total arrivals ÷ origin capacity**. The configuration's job is to spread arrivals across roughly that drain window.

`waitSeconds.max` (and `lottery.luckyWaitSeconds.max`) define the wait window. If you spread `N` arrivals uniformly across a `W`-second window, the average admission rate is `N / W` per second. Match that to your origin's sustained capacity.

### Reference scenarios

| Scenario | Burst size | Origin capacity | Recommended config | Approx. drain time | Median wait |
|---|---|---|---|---|---|
| **Small site, surprise traffic spike** (TikTok, press) | 10k arrivals over 5 min | ~20 req/sec | Plain splay, `waitSeconds: { min: 30, max: 600 }` | ~10 min | ~5 min |
| **Mid-size sale** (10k items, regional) | 100k arrivals over 5 min | ~100 req/sec | Bimodal lottery, `waitSeconds: { min: 60, max: 1200 }`, `luckyChance: 0.05`, `luckyWaitSeconds: { min: 0, max: 60 }` | ~17 min | ~10 min (95% within 20 min) |
| **National e-commerce drop** (sale event) | 500k arrivals over 5 min | ~200 req/sec | Bimodal lottery, `waitSeconds: { min: 60, max: 3000 }`, `luckyChance: 0.02`, `luckyWaitSeconds: { min: 0, max: 60 }` | ~42 min | ~25 min |
| **Major ticketed event / drop** | 1.2M arrivals over 5 min | ~200 req/sec | Bimodal lottery, `waitSeconds: { min: 60, max: 6000 }`, `luckyChance: 0.01`, `luckyWaitSeconds: { min: 0, max: 60 }` | ~100 min | ~50 min |
| **Strict throughput contract** (legal/infra cap, must-not-exceed) | Any | Hard cap of N/sec | Add `admissionCap: { perSlot: N×60, slotSeconds: 60, store }` to whichever above matches | Same as above | Same as above |
| **Internal tools / corporate intranet** under deploy day load | 5k arrivals over 1 min | ~50 req/sec | Plain splay, `waitSeconds: { min: 10, max: 120 }` | ~2 min | ~1 min |

The general formula:

```
target_admit_rate    = origin_capacity (req/sec)
required_window      = total_arrivals / target_admit_rate
waitSeconds.max      ≈ required_window  (round up for safety)
waitSeconds.min      = small (e.g. 30–60s) — the shortest wait you'll show
luckyChance          = how many fast-track entrants you can absorb in luckyWaitSeconds
luckyWaitSeconds.max = (luckyChance × total_arrivals) / target_admit_rate
```

The `luckyWaitSeconds.max` formula keeps the lucky bucket's admission rate equal to `target_admit_rate`. So lucky users land at the same per-second rate as unlucky ones — they just go through their (smaller) bucket faster.

### Why these numbers feel long

For very large bursts against a typical origin, the numbers look long because **the drain time is set by your origin, not by waypoint**. A 1.2M-user event against a 200/sec origin is 100 minutes, full stop. Any waiting room would give you the same answer; waypoint just makes it *feel* like a queue rather than a 503.

If 100 minutes is too long, you need either: (a) more origin capacity, (b) a smaller event, or (c) a different business model (lottery distribution, pre-registration). Waypoint can't compress what your origin can't serve.

## API

### `new Waypoint<TUserBindings>(options)`

| option | type | required | description |
| --- | --- | --- | --- |
| `secret` | `string` | yes | HMAC key for the underlying waypass tokens. |
| `waitSeconds` | `{ min: number; max: number }` | yes | Range for the per-session jittered wait (the "regular" / unlucky bucket if a lottery is configured). |
| `activeSeconds` | `number` | yes | How long an admitted visitor stays admitted. |
| `purpose` | `string` | no | waypass `purpose` field. Default `"waypoint"`. |
| `jitter` | `(sessionId, min, max) => number` | no | Override the default jitter. |
| `cookieName` | `string` | no | Default `"waypoint"`. |
| `cookieDomain` | `string` | no | Cookie `Domain` attribute. Default unset (host-only). |
| `cookiePath` | `string` | no | Cookie `Path` attribute. Default `"/"`. |
| `lottery` | `LotteryOptions` | no | Bimodal lottery. See "Three modes" above. |
| `admissionCap` | `AdmissionCapOptions` | no | Per-slot rate cap. See "Three modes" above. |

`TUserBindings` extends `Record<string, string>`. waypoint always combines the user's bindings with a required `sessionId` field.

### Methods

| method | returns | description |
| --- | --- | --- |
| `issueWaiting(bindings)` | `string` | Mint a fresh waiting cookie with a jittered `entryAt`. |
| `issueActive(bindings)` | `string` | Mint a fresh active cookie. |
| `verify(cookie, bindings)` | `Promise<VerifyResult>` | Verify a presented cookie against bindings. |
| `evaluate({ cookie, bindings })` | `Promise<Verdict>` | The verdict orchestrator — what most callers use. |

`Verdict` is a discriminated union on `action`:

- `{ action: "pass" }` — visitor is already admitted; forward to origin.
- `{ action: "admit"; cookie }` — admit them now; set the cookie.
- `{ action: "wait"; cookie; entryAt }` — show the waiting page and set the cookie. `entryAt` is a Unix timestamp in seconds.

## Cookie format

Tokens are produced by [waypass](https://github.com/curtyo18/waypass); defer there for the wire format. waypoint uses waypass's `data` field to carry `{ state: "waiting" | "active", entryAt? }`. The cookie is re-signed on the wait → admit transition rather than swapping cookies — there is exactly one `waypoint` cookie at any time.

## Admission cap details

The cap is per-slot. Time gets carved into fixed `slotSeconds` buckets; each slot has its own counter capped at `perSlot`. When a visitor becomes eligible to admit, waypoint asks the store whether the current slot has room. If yes, admit. If no, the visitor's waiting cookie is re-signed with `entryAt` set to the start of the next slot.

```
slotSeconds = 60, perSlot = 1000

  time:   12:00:00       12:01:00       12:02:00       12:03:00
          │              │              │              │
  slot:   28833335       28833336       28833337       28833338
          ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
          │ count: 0 │   │ count: 0 │   │ count: 0 │   │ count: 0 │
          │ cap: 1000│   │ cap: 1000│   │ cap: 1000│   │ cap: 1000│
          └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

`AdmissionStore` is one method, BYO implementation:

```ts
type AdmissionStore = {
  tryAdmit(slot: string, cap: number): Promise<boolean>;
};
```

`tryAdmit` must atomically read the current count, compare to `cap`, and either increment-and-return-true or return-false-without-incrementing. Two concurrent callers must not both push the count above `cap`.

`onStoreError` controls behaviour when `tryAdmit` throws. Default is `"open"` — admit the caller, favouring availability. `"closed"` treats the throw as "full" and bumps to the next slot, favouring the cap.

For very high-throughput rooms, **shard the store**: hash the sessionId across N counters and cap each at `perSlot / N`. The Akamai EdgeKV example does this; the Cloudflare Durable Object example doesn't need to (DOs are strongly consistent and handle ~1–5k req/sec each).

See [examples/cloudflare/](./examples/cloudflare) for a Durable Object adapter and [examples/akamai/](./examples/akamai) for a sharded EdgeKV adapter.

## Static page

[`static-page/index.html`](./static-page/index.html) is the default waiting UI: a single self-contained HTML file that reads `?returnTo=` and `?t=` from the query string, counts down to `t` (Unix seconds), then forwards to `returnTo`. Host it anywhere static — S3, GitHub Pages, the edge — and have your gate redirect to it.

The page validates `returnTo` against an `ALLOWED_HOSTS` array near the top of the inline script. **Edit that array for your deployment.** Anything off-list falls back to `/` on the page's own origin.

## Security notes

- **Jitter is deterministic per `sessionId`.** Honest reloaders see the same `entryAt` they saw on the first request — they can't game the splay by hammering reload.
- **The cookie is `HttpOnly; Secure; SameSite=Lax; Path=/`.** Set those attributes when emitting `Set-Cookie`.
- **The static page's `ALLOWED_HOSTS` is the only phishing defence on the redirect.** Treat it as a security-critical config; review it the same way you'd review a CORS origin list.

## On bot resistance

Honest framing: **waypoint is not a bot defence.** Without strong identity binding, a sufficiently determined bot can roll fresh sessions to skip past short waits — the splay is a load shaper, not an identity check. The admission cap helps cap *throughput* even under cookie-rolling, but it does so by treating bots and honest users the same — bots fill the cap and honest users wait behind them. The cap protects your *origin* from overload; it doesn't protect *honest users* from being elbowed aside.

The real fix for cookie-rolling is **upstream identity that's expensive to mint**:

```ts
const room = new Waypoint<{ accountId: string }>({ /* ... */ });

const verdict = await room.evaluate({
  cookie,
  bindings: {
    sessionId,                // weak — just a cookie
    accountId: req.user.id,   // strong — requires login + account
  },
});
```

Bind to whatever identity already requires friction in your stack (verified accounts, pre-registered users, paid memberships). Each binding is something a bot has to forge consistently across rolls. The deterministic jitter HMAC keys off `sessionId` by default, but you can pass `jitter` to key off whichever binding is harder to refresh.

For serious bot threat, layer Cloudflare Bot Management, Akamai Bot Manager, hCaptcha enterprise, or DataDome in front of waypoint. They handle bot detection (with the caveat that residential proxies and stealth automation defeat them often enough that you should also have account-level identity above). waypoint does the queueing; your bot mitigation does the bot detection; your account system does the identity.

## License

MIT
