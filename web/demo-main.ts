import { Waypoint, InMemoryAdmissionStore } from "../src/index.js";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const set = (id: string, text: string) => { document.getElementById(id)!.textContent = text; };

let timer: number | undefined;

function singleVisitorRun() {
  if (timer) { clearInterval(timer); timer = undefined; }
  const wp = new Waypoint({
    secret: "demo-secret",
    waitSeconds: { min: Number($("wmin").value) || 3, max: Number($("wmax").value) || 8 },
    activeSeconds: Number($("active").value) || 6,
  });
  const sessionId = "sess-" + Math.floor((performance.now() % 1e6));
  let cookie: string | undefined;

  const tick = async () => {
    const v = await wp.evaluate({ cookie, bindings: { sessionId } });
    cookie = "cookie" in v ? v.cookie : cookie;
    const now = Math.floor(Date.now() / 1000);
    if (v.action === "wait") set("status", `waiting… admit in ~${Math.max(0, v.entryAt - now)}s`);
    else if (v.action === "admit") set("status", "admitted ✓  (active session cookie set)");
    else set("status", "passing ✓  (inside the active window)");
  };
  void tick();
  timer = setInterval(tick, 1000) as unknown as number;
}

document.getElementById("enter")!.addEventListener("click", singleVisitorRun);
document.getElementById("reset")!.addEventListener("click", () => {
  if (timer) clearInterval(timer); timer = undefined; set("status", "idle");
});

document.getElementById("rush")!.addEventListener("click", async () => {
  const store = new InMemoryAdmissionStore();
  const wp = new Waypoint({
    secret: "demo-secret",
    waitSeconds: { min: 0, max: 0 },
    activeSeconds: 6,
    admissionCap: { perSlot: Number($("perSlot").value) || 2, slotSeconds: Number($("slot").value) || 4, store },
  });
  const n = Number($("visitors").value) || 6;
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const first = await wp.evaluate({ cookie: undefined, bindings: { sessionId: `v${i}` } });
    const cookie = "cookie" in first ? first.cookie : undefined;
    const v = await wp.evaluate({ cookie, bindings: { sessionId: `v${i}` } });
    lines.push(`visitor ${i}: ${v.action}${v.action === "wait" ? ` (bumped, entryAt=${(v as { entryAt: number }).entryAt})` : ""}`);
  }
  set("cap", lines.join("\n") + `\n\n→ only perSlot admit per slot; the rest are bumped to the next slot.`);
});
