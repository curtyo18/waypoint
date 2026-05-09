# waypoint on Akamai EdgeWorker

A runnable example wiring waypoint to an Akamai EdgeWorker, with the optional
admission cap backed by a sharded EdgeKV counter.

## Why this is a reimplementation, not an import

Akamai EdgeWorker has no Node.js compatibility shim. waypass uses
`node:crypto` for HMAC, which is not available — so we cannot import the
`waypoint` TypeScript library directly. `wire.js` reimplements the cookie
wire format using `crypto.subtle` (Web Crypto), keeping the field naming
and binding-canonicalisation rules from waypass v0.0.2 byte-for-byte: a
token issued here would parse the same way as one issued by waypass, and
vice versa.

If you change the wire format in waypass, change `wire.js` too.

## Layout

- `main.js` — the EdgeWorker entry. Reads cookies, verifies, decides
  pass/wait/admit, and writes Set-Cookie + Location.
- `wire.js` — `create` / `verify` mirroring waypass's signed-cookie format.
- `admission-store-edgekv.js` — sharded EdgeKV-backed counter.
- `bundle.json` — Akamai's required bundle metadata.

## Sharding and the bounded-overshoot trade-off

EdgeKV is eventually consistent across PoPs, with a per-key sustained
write ceiling of about 1 write/second. Two consequences fall out of that:

1. **Bounded overshoot.** Two admitters at the slot boundary may both
   read "under cap", both increment, and both be admitted. The overshoot
   is bounded by EdgeKV's consistency window — pick `perSlot` so that
   even a worst-case slot doesn't blow your origin.

2. **Per-key write rate limit.** Pushing every admission for a slot
   through one EdgeKV key would saturate that key. Sharding into
   `SHARD_COUNT` independent keys (defaulted to 10) spreads the writes;
   each shard enforces `ceil(perSlot / SHARD_COUNT)`. Visitors stick to
   the same shard for their whole session via FNV-1a(`sessionId`), so
   the cap behaves as a per-shard rate limit rather than a strict global
   one.

Tune `SHARD_COUNT` and `perSlot` to your traffic and risk tolerance.

## EdgeKV setup

You need an EdgeKV namespace and group:

```sh
akamai edgekv create namespace --staging waypoint
akamai edgekv create namespace --production waypoint
# Group is created on first write; no explicit step needed.
```

The store's defaults expect namespace `waypoint`, group `admissions`.

## Package and upload

```sh
cd examples/akamai
tar -czf bundle.tgz main.js wire.js admission-store-edgekv.js bundle.json
akamai edgeworkers upload --bundle bundle.tgz <edgeworker-id>
akamai edgeworkers activate <edgeworker-id> staging <version>
```

## Smoke test (manual)

There's no automated test for this example — it depends on EdgeWorker and
EdgeKV runtimes that don't exist outside Akamai's environment. The closest
offline check is wire-format parity with waypass:

1. Issue a token via `wire.js create(...)` running under Node (after
   stubbing `crypto.subtle` from `node:crypto/webcrypto`).
2. Pass that token to waypass's `verify(...)`.
3. Confirm `ok: true`.

That parity check is asserted by following the spec, not enforced in CI —
ci would need a Node-compatible build of `wire.js`. If you change either
side, run the check before shipping.
