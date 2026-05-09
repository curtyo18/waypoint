# waypoint on Cloudflare Workers

A runnable end-to-end demo of waypoint on a Cloudflare Worker, with the
optional admission cap backed by a Durable Object that holds the
per-slot counters.

One worker serves the whole demo: the gate, a mock product page (the
"protected origin"), the static waiting page, and a small live demo
panel.

## Layout

- `worker.ts` — gate + mock origin + demo helpers.
  - `GET /` (and any unhandled path) → gated. Verdict mapped to a 200
    HTML response (the mock product page) or a 302 to `/__waiting`.
  - `GET /__waiting` → fetches the canonical static page from
    `static-page/index.html` (via `env.ASSETS`) and rewrites
    `ALLOWED_HOSTS` to include the dev origin so the redirect lands
    back here.
  - `GET /__demo` → control panel HTML.
  - `GET /__demo/state` → JSON snapshot for the panel: cookie phase,
    sessionId, entryAt/exitAt, current admission counts per slot.
  - `GET /__demo/reset` → clears both cookies, redirects back to
    `/__demo`.
- `counter-do.ts` — Durable Object holding `Map<slot, count>`. Two
  endpoints: `/tryAdmit` (used by the gate) and `/peek` (used by the
  panel for read-only display).
- `admission-store-do.ts` — `AdmissionStore` adapter the worker passes
  to `Waypoint`.
- `wrangler.toml` — Durable Object binding, `nodejs_compat` flag, and
  an `[assets]` binding pointing at the canonical static page with
  `run_worker_first = true` so the worker can post-process before
  serving.

## Why `nodejs_compat`?

waypass uses `node:crypto` for HMAC. Workers can resolve `node:` imports
at runtime when `compatibility_flags = ["nodejs_compat"]` is set.
Without that flag the Worker fails to start.

## Run the demo

```sh
cd examples/cloudflare
npm install
npx wrangler dev --port 8787 --local-protocol https
```

Then open the demo panel:

```
https://localhost:8787/__demo
```

(Self-signed cert — accept the browser warning.) From there:

- Click **Visit the gated site (/)** to hit the gate. With no cookie
  you'll be redirected to the static waiting page; the page counts
  down and forwards back to the worker; when `entryAt` has passed,
  you're admitted to the mock product page.
- The panel polls `/__demo/state` once a second so you can watch the
  cookie's `phase` flip from `fresh` → `waiting` → `active`, and see
  the per-slot counter on the Durable Object increment as you (and
  any incognito tabs) get admitted.
- Click **Reset cookies (re-roll)** to wipe state and start over.
- Open the gate in an *incognito window* to act as a parallel
  user against the same DO counter — useful for watching the slot
  fill up.

The configured knobs (`waitSeconds`, `activeSeconds`, `perSlot`,
`slotSeconds`) live near the top of `worker.ts`. Edit and save —
wrangler hot-reloads.

## Drive it from curl

```sh
# Use --insecure (-k) for the self-signed cert.
curl -sk -i -c jar.txt -b jar.txt https://localhost:8787/
# expect 302 with Set-Cookie: waypoint=...; Location: /__waiting?...

# wait until past the cookie's entryAt, then:
curl -sk -i -c jar.txt -b jar.txt https://localhost:8787/
# expect 200 + Set-Cookie: waypoint=... (active)

curl -sk -i -c jar.txt -b jar.txt https://localhost:8787/
# expect 200, no Set-Cookie (cookie still valid)
```

Curl needs `https` because the cookies are set with `Secure`; on plain
HTTP the cookie jar would silently drop them.

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

The example's TypeScript should compile under its own tsconfig:

```sh
npx tsc --noEmit -p examples/cloudflare/tsconfig.json
```

Beyond compile, the runtime check is the demo flow above.
