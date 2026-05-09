# waypoint

Stateless waiting-room library: signed cookies + edge-worker gate + static page. Sister project to [waypass](https://github.com/curtyo18/waypass).

**Status: scaffold.** The library, static page, and per-platform examples are tracked as discrete issues — see the [issue tracker](https://github.com/curtyo18/waypoint/issues). The README will be filled in when the work in those issues lands.

## Design

The full design spec is captured separately. Headlines:

- Stateless splay buffer by default — each arrival gets a randomised `entryAt` deterministically derived from `sessionId`. No global counter needed for the basic load-spreading case.
- Optional per-slot admission cap (`AdmissionStore` interface, BYO implementation) for bot resistance. Cloudflare Durable Object and sharded Akamai EdgeKV are the planned reference implementations.
- One signed cookie carrying the user's `state` (`waiting` / `active`). Built on waypass tokens.
- Single self-contained static HTML page for the wait UI. Deployable to S3, GitHub Pages, or any static host.

## License

MIT
