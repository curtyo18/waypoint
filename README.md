# waypoint

Stateless waiting-room library: signed cookies + edge-worker gate + static
page. Sister project to [waypass](https://github.com/curtyo18/waypass).

waypoint smooths a thundering-herd arrival into a steady stream by handing
each visitor a small randomised wait — a *splay buffer* — held entirely in
a signed cookie. No queue, no per-session state on your origin, no
Redis. The same primitive carries an optional per-slot admission cap when
the splay alone isn't enough.

You'd reach for waypoint when you have a known traffic spike (a sale, a
ticket drop, an embargo lift) and want to bound concurrent arrivals
without standing up queue infrastructure.

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

The first visit issues a `waiting` cookie and redirects to the static
waiting page. The page counts down to `entryAt`, then sends the visitor
back. The next request arrives past `entryAt` and gets re-signed as
`active`.

## API

### `new Waypoint<TUserBindings>(options)`

| option | type | required | description |
| --- | --- | --- | --- |
| `secret` | `string` | yes | HMAC key for the underlying waypass tokens. |
| `waitSeconds` | `{ min: number; max: number }` | yes | Range for the per-session jittered wait. |
| `activeSeconds` | `number` | yes | How long an admitted visitor stays admitted. |
| `purpose` | `string` | no | waypass `purpose` field. Default `"waypoint"`. |
| `jitter` | `(sessionId, min, max) => number` | no | Override the default jitter. |
| `cookieName` | `string` | no | Default `"waypoint"`. |
| `cookieDomain` | `string` | no | Cookie `Domain` attribute. Default unset (host-only). |
| `cookiePath` | `string` | no | Cookie `Path` attribute. Default `"/"`. |
| `admissionCap` | `AdmissionCapOptions` | no | Optional per-slot rate cap. See below. |

`TUserBindings` extends `Record<string, string>`. waypoint always combines
the user's bindings with a required `sessionId` field.

### Methods

| method | returns | description |
| --- | --- | --- |
| `issueWaiting(bindings)` | `string` | Mint a fresh waiting cookie with a jittered `entryAt`. |
| `issueActive(bindings)` | `string` | Mint a fresh active cookie. |
| `verify(cookie, bindings)` | `VerifyResult` | Verify a presented cookie against bindings. |
| `evaluate({ cookie, bindings })` | `Promise<Verdict>` | The verdict orchestrator — what most callers use. |

`Verdict` is a discriminated union on `action`:

- `{ action: "pass" }` — visitor is already admitted; forward to origin.
- `{ action: "admit"; cookie }` — admit them now; set the cookie.
- `{ action: "wait"; cookie; entryAt }` — show the waiting page and set
  the cookie. `entryAt` is a Unix timestamp in seconds.

## Cookie format

Tokens are produced by [waypass](https://github.com/curtyo18/waypass);
defer there for the wire format. waypoint uses waypass's `data` field to
carry `{ state: "waiting" | "active", entryAt? }`. The cookie is re-signed
on the wait → admit transition rather than swapping cookies — there is
exactly one `waypoint` cookie at any time.

## Optional admission cap

The default behaviour is a stateless splay buffer: every arrival gets a
deterministic `entryAt` and is admitted when their wait elapses. That
spreads load over time but doesn't enforce a hard ceiling.

For a hard ceiling, supply an `AdmissionStore`:

```ts
type AdmissionStore = {
  tryAdmit(slot: string, cap: number): Promise<boolean>;
};
```

`tryAdmit` must atomically read the current count, compare to `cap`, and
either increment-and-return-true or return-false-without-incrementing. Two
concurrent callers must not both push the count above `cap`.

waypoint divides time into fixed `slotSeconds` buckets. When a visitor
becomes eligible to admit, waypoint asks the store whether the current
slot has room. If yes, admit. If no, the visitor's waiting cookie is
re-signed with `entryAt` set to the start of the next slot.

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

There are two postures for tuning the cap, and which you pick changes how
much you trust each piece of the system.

**Jitter-heavy.** Wide jitter is the primary load shaper; the cap is an
anomaly defence — a backstop for when more people show up than you
expected.

```ts
new Waypoint({
  secret,
  waitSeconds: { min: 0, max: 600 }, // 10 minutes of splay
  activeSeconds: 600,
  admissionCap: {
    perSlot: 5000,                   // headroom over expected
    slotSeconds: 60,
    store,
  },
});
```

**Cap-heavy.** The cap is the truth; jitter is small and exists only to
desynchronise client retries.

```ts
new Waypoint({
  secret,
  waitSeconds: { min: 5, max: 30 },  // tiny splay
  activeSeconds: 600,
  admissionCap: {
    perSlot: 200,                    // tight; matches origin capacity
    slotSeconds: 1,
    store,
  },
});
```

`onStoreError` controls behaviour when `tryAdmit` throws. Default is
`"open"` — admit the caller, favouring availability. `"closed"` treats
the throw as "full" and bumps to the next slot, favouring the cap.

See [examples/cloudflare/](./examples/cloudflare) for a Durable Object
adapter and [examples/akamai/](./examples/akamai) for a sharded EdgeKV
adapter.

## Static page

[`static-page/index.html`](./static-page/index.html) is the default
waiting UI: a single self-contained HTML file that reads `?returnTo=` and
`?t=` from the query string, counts down to `t` (Unix seconds), then
forwards to `returnTo`. Host it anywhere static — S3, GitHub Pages, the
edge — and have your gate redirect to it.

The page validates `returnTo` against an `ALLOWED_HOSTS` array near the
top of the inline script. **Edit that array for your deployment.**
Anything off-list falls back to `/` on the page's own origin.

## Security notes

- **Jitter is deterministic per `sessionId`.** Honest reloaders see the
  same `entryAt` they saw on the first request — they can't game the
  splay by hammering reload.
- **The cookie is `HttpOnly; Secure; SameSite=Lax; Path=/`.** Set those
  attributes when emitting `Set-Cookie`.
- **The static page's `ALLOWED_HOSTS` is the only phishing defence on the
  redirect.** Treat it as a security-critical config; review it the same
  way you'd review a CORS origin list.

## Not bot-resistant on its own

Without the optional admission cap, a sufficiently determined bot can
roll fresh sessions to skip past short waits — the splay is a load
shaper, not a gate. The admission cap (above) is the bot defence: it
caps admissions per slot regardless of how many sessions a client cycles
through.

For serious bot threat, layer Cloudflare Bot Management, Akamai Bot
Manager, or equivalent in front of waypoint. waypoint does the queueing;
your bot mitigation does the bot detection.

## License

MIT
