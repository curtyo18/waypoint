# waypoint on Cloudflare Workers

A runnable example wiring waypoint to a Cloudflare Worker, with the optional
admission cap backed by a Durable Object that holds the per-slot counters.

## Layout

- `worker.ts` — the request handler. Reads the `waypoint` cookie, calls
  `Waypoint.evaluate`, and either proxies to a stub origin (`pass` /
  `admit`) or 302s to the waiting page (`wait`).
- `counter-do.ts` — a Durable Object holding `Map<slot, count>`. The DO's
  single-threaded execution model is what makes `tryAdmit` atomic.
- `admission-store-do.ts` — a thin `AdmissionStore` adapter that fetches
  the DO over `stub.fetch(...)` from anywhere in the Worker.
- `wrangler.toml` — binds the DO and turns on `nodejs_compat` so that
  waypass's `node:crypto` resolves at runtime.

## Why `nodejs_compat`?

waypass uses `node:crypto` for HMAC. Workers can resolve `node:` imports at
runtime when `compatibility_flags = ["nodejs_compat"]` is set. Without that
flag the Worker fails to start.

## Run locally

```sh
cd examples/cloudflare
npm install
npx wrangler dev
```

Then drive it with curl. First request → wait (302 to the waiting page),
second request before `entryAt` → still wait, second request after
`entryAt` → admit + active cookie.

```sh
curl -i -c jar.txt -b jar.txt http://localhost:8787/
# expect 302 with Set-Cookie: waypoint=...; Location: /__waiting?returnTo=...&t=...

# wait until past `t`, then:
curl -i -c jar.txt -b jar.txt http://localhost:8787/
# expect 200 + Set-Cookie: waypoint=... (active)

curl -i -c jar.txt -b jar.txt http://localhost:8787/
# expect 200, no Set-Cookie (cookie still valid)
```

## Deploy

```sh
npx wrangler deploy
```

Set `WAYPOINT_SECRET` as a secret rather than the dev value in
`wrangler.toml`:

```sh
npx wrangler secret put WAYPOINT_SECRET
```

## Smoke test (manual)

The example's TypeScript should compile under the example's own tsconfig:

```sh
npx tsc --noEmit -p examples/cloudflare/tsconfig.json
```

Beyond compile, the only end-to-end check is the curl flow above.
