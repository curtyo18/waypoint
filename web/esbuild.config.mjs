import { build } from "esbuild";
import { cp } from "node:fs/promises";

// Bundles the browser playground. Aliases node:crypto to the demo-only sync
// shim and injects a Buffer global so the bundled waypoint + waypass source
// runs unchanged in the browser.
await build({
  entryPoints: ["web/demo-main.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "web/dist/demo.js",
  sourcemap: true,
  minify: true,
  alias: { "node:crypto": "./web/shims/node-crypto.ts" },
  inject: ["web/shims/buffer.ts"],
  logLevel: "info",
});

await cp("web/index.html", "web/dist/index.html");
