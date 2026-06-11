import { Waypoint, InMemoryAdmissionStore } from "../src/index.js";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const el = (id: string) => document.getElementById(id)!;
const show = (id: string, visible: boolean) => { el(id).hidden = !visible; };

// Same wording the shipped static-page uses: "Xm Ys".
function format(totalSec: number): string {
  const s = Math.max(0, totalSec);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

let timer: number | undefined;

function stopTimer() {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

// Drive the real waiting view from a live Waypoint.evaluate(). A short,
// demo-friendly wait keeps the countdown meaningful without being tedious.
function joinQueue() {
  stopTimer();
  show("intro", false);
  show("admitted", false);
  show("waiting", true);
  el("countdown").textContent = "--";
  el("wverdict").textContent = "";

  const wp = new Waypoint({
    secret: "demo-secret",
    waitSeconds: { min: 5, max: 12 },
    activeSeconds: 8,
  });
  const sessionId = "sess-" + Math.floor(performance.now() % 1e6);
  let cookie: string | undefined;

  const tick = async () => {
    const v = await wp.evaluate({ cookie, bindings: { sessionId } });
    if ("cookie" in v) cookie = v.cookie;
    const now = Math.floor(Date.now() / 1000);

    if (v.action === "wait") {
      el("countdown").textContent = format(v.entryAt - now);
      el("wverdict").textContent = `evaluate() → wait · entryAt in ${Math.max(0, v.entryAt - now)}s`;
      return;
    }

    // admit or pass → forwarded through the gate.
    stopTimer();
    show("waiting", false);
    show("admitted", true);
  };

  void tick();
  timer = setInterval(tick, 1000) as unknown as number;
}

el("join").addEventListener("click", joinQueue);
el("again").addEventListener("click", joinQueue);

// Admission-cap rush: N visitors hit one gate sharing an InMemoryAdmissionStore;
// only perSlot are admitted per slot, the rest are bumped to the next slot.
el("rush").addEventListener("click", async () => {
  const store = new InMemoryAdmissionStore();
  const wp = new Waypoint({
    secret: "demo-secret",
    waitSeconds: { min: 0, max: 0 },
    activeSeconds: 6,
    admissionCap: {
      perSlot: Number($("perSlot").value) || 2,
      slotSeconds: Number($("slot").value) || 4,
      store,
    },
  });
  const n = Number($("visitors").value) || 6;
  const lines: string[] = [];
  let admitted = 0;
  for (let i = 0; i < n; i++) {
    const first = await wp.evaluate({ cookie: undefined, bindings: { sessionId: `v${i}` } });
    const cookie = "cookie" in first ? first.cookie : undefined;
    const v = await wp.evaluate({ cookie, bindings: { sessionId: `v${i}` } });
    if (v.action === "admit") admitted++;
    const bumped = v.action === "wait" ? `  → bumped to next slot (entryAt ${(v as { entryAt: number }).entryAt})` : "";
    lines.push(`visitor ${i}: ${v.action}${bumped}`);
  }
  el("cap").textContent =
    lines.join("\n") + `\n\n${admitted}/${n} admitted this slot — the rest spread to later slots.`;
});
