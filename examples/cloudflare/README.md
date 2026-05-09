# waypoint on Cloudflare Workers

A runnable end-to-end demo of waypoint on a Cloudflare Worker. The default
config uses **splay buffer + bimodal lottery** — the recommended mode for
production use. The optional admission cap is wired in as reference code
but disabled in the default demo (see "Enabling the optional admission
cap" below).

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
    sessionId, entryAt/exitAt, lottery bucket, configured knobs.
  - `GET /__demo/reset` → clears both cookies, redirects back to
    `/__demo`.
- `counter-do.ts` and `admission-store-do.ts` — **reference code for the
  optional admission cap; not used by the default demo.** See the
  enable-it section below.
- `wrangler.toml` — `nodejs_compat` flag and an `[assets]` binding
  pointing at the canonical static page with `run_worker_first = true`
  so the worker can post-process before serving.

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
- The panel shows your current cookie phase (`fresh` / `waiting` /
  `active`) and your **lottery bucket** (`lucky` or `unlucky`). With
  the demo's 30% lucky chance, every ~3rd reset you'll land in the
  lucky bucket and get a 1–5 second wait instead of 10–60 seconds.
- Click **Reset cookies (re-roll)** to wipe state and start over with
  a fresh sessionId — possibly flipping you to the other bucket.
- Open the gate in an *incognito window* to act as a parallel user
  with a different session and (likely) a different bucket.

The configured knobs (`waitSeconds`, `activeSeconds`, `luckyChance`,
`luckyWaitSeconds`) live near the top of `worker.ts`. Edit and save —
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

## Enabling the optional admission cap

The default demo intentionally omits the admission cap because casual
demo traffic never approaches the cap, so the visualisation would be
empty. To enable it for production use (or to play with the cap
behaviour):

1. **Re-export the Durable Object from `worker.ts`:**
   ```ts
   export { CounterDO } from "./counter-do.js";
   ```
2. **Re-import the admission store + add it to `Env`:**
   ```ts
   import { DurableObjectAdmissionStore } from "./admission-store-do.js";
   import type { AdmissionStoreEnv } from "./admission-store-do.js";

   type Env = AdmissionStoreEnv & {
     WAYPOINT_SECRET: string;
     ASSETS: { fetch(req: Request): Promise<Response> };
   };
   ```
3. **Wire the cap into `makeRoom`:**
   ```ts
   admissionCap: {
     perSlot: 50,
     slotSeconds: 5,
     store: new DurableObjectAdmissionStore(env),
     onStoreError: "open",
   },
   ```
4. **Uncomment the `[[durable_objects.bindings]]` and `[[migrations]]`
   sections in `wrangler.toml`.**

After those four edits, the cap is active. With the default
`perSlot: 50, slotSeconds: 5` (10 admissions/sec capacity), bumping
behaviour is rare under casual usage; drop `perSlot` to 1 or 2 if you
want to see the cap fire visibly with a few incognito tabs.

## Smoke test (manual)

The example's TypeScript should compile under its own tsconfig:

```sh
npx tsc --noEmit -p examples/cloudflare/tsconfig.json
```

Beyond compile, the runtime check is the demo flow above.
