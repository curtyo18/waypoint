import { describe, expect, it, jest } from "@jest/globals";
import { Waypoint } from "./waypoint.js";
import { defaultJitter } from "./jitter.js";
import { InMemoryAdmissionStore } from "./in-memory-admission-store.js";
import type { AdmissionStore } from "./types.js";

const SECRET = "test-secret-please-change";

function makeRoom() {
  return new Waypoint<{ shop: string }>({
    secret: SECRET,
    waitSeconds: { min: 30, max: 90 },
    activeSeconds: 600,
    purpose: "test",
  });
}

function makeRoomWithCap(store: AdmissionStore, perSlot: number, slotSeconds: number, onStoreError?: "open" | "closed") {
  return new Waypoint<{ shop: string }>({
    secret: SECRET,
    waitSeconds: { min: 30, max: 90 },
    activeSeconds: 600,
    purpose: "test",
    admissionCap: { perSlot, slotSeconds, store, onStoreError },
  });
}

describe("Waypoint", () => {
  describe("issueWaiting", () => {
    it("round-trips through verify with state=waiting and entryAt in [now+min, now+max]", async () => {
      const room = makeRoom();
      const before = Math.floor(Date.now() / 1000);
      const cookie = room.issueWaiting({ sessionId: "s-1", shop: "demo" });
      const after = Math.floor(Date.now() / 1000);

      const verified = await room.verify(cookie, { sessionId: "s-1", shop: "demo" });
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.state).toBe("waiting");
      if (verified.state !== "waiting") return;
      expect(verified.entryAt).toBeGreaterThanOrEqual(before + 30);
      expect(verified.entryAt).toBeLessThanOrEqual(after + 90);
    });
  });

  describe("issueActive", () => {
    it("round-trips through verify with state=active and no entryAt", async () => {
      const room = makeRoom();
      const cookie = room.issueActive({ sessionId: "s-1", shop: "demo" });
      const verified = await room.verify(cookie, { sessionId: "s-1", shop: "demo" });
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.state).toBe("active");
    });
  });

  describe("default jitter", () => {
    it("is deterministic per sessionId within a day", () => {
      const jitter = defaultJitter(SECRET);
      const first = jitter("alice", 30, 90);
      const second = jitter("alice", 30, 90);
      expect(first).toBe(second);
      expect(first).toBeGreaterThanOrEqual(30);
      expect(first).toBeLessThanOrEqual(90);
    });

    it("differs across distinct sessionIds (with high probability)", () => {
      const jitter = defaultJitter(SECRET);
      const samples = new Set<number>();
      for (let ix = 0; ix < 50; ix++) {
        samples.add(jitter(`user-${ix}`, 0, 1_000_000));
      }
      // Expect virtually all 50 samples to be unique across a million-wide
      // span. A clash here means the HMAC output is not behaving as a CSPRNG.
      expect(samples.size).toBeGreaterThan(45);
    });

    it("returns the lower bound when min === max", () => {
      const jitter = defaultJitter(SECRET);
      expect(jitter("anyone", 42, 42)).toBe(42);
    });
  });

  describe("evaluate", () => {
    it("issues a waiting cookie when no cookie is presented", async () => {
      const room = makeRoom();
      const verdict = await room.evaluate({
        cookie: undefined,
        bindings: { sessionId: "s-1", shop: "demo" },
      });
      expect(verdict.action).toBe("wait");
      if (verdict.action !== "wait") return;
      expect(verdict.cookie).toMatch(/.+/);
      expect(verdict.entryAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("returns wait with the same cookie when entryAt is in the future", async () => {
      const room = makeRoom();
      const cookie = room.issueWaiting({ sessionId: "s-1", shop: "demo" });
      const verdict = await room.evaluate({
        cookie,
        bindings: { sessionId: "s-1", shop: "demo" },
      });
      expect(verdict.action).toBe("wait");
      if (verdict.action !== "wait") return;
      expect(verdict.cookie).toBe(cookie);
    });

    it("admits with a fresh active cookie when entryAt has passed", async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const room = makeRoom();
        const waitCookie = room.issueWaiting({ sessionId: "s-1", shop: "demo" });
        // Advance past the longest possible jitter.
        jest.setSystemTime(new Date(Date.now() + 91 * 1000));

        const verdict = await room.evaluate({
          cookie: waitCookie,
          bindings: { sessionId: "s-1", shop: "demo" },
        });
        expect(verdict.action).toBe("admit");
        if (verdict.action !== "admit") return;
        expect(verdict.cookie).not.toBe(waitCookie);

        const verified = await room.verify(verdict.cookie, { sessionId: "s-1", shop: "demo" });
        expect(verified.ok).toBe(true);
        if (!verified.ok) return;
        expect(verified.state).toBe("active");
      } finally {
        jest.useRealTimers();
      }
    });

    it("passes when an active cookie is presented before expiry", async () => {
      const room = makeRoom();
      const activeCookie = room.issueActive({ sessionId: "s-1", shop: "demo" });
      const verdict = await room.evaluate({
        cookie: activeCookie,
        bindings: { sessionId: "s-1", shop: "demo" },
      });
      expect(verdict.action).toBe("pass");
    });

    it("treats an expired cookie as a fresh wait", async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const room = makeRoom();
        const cookie = room.issueWaiting({ sessionId: "s-1", shop: "demo" });
        // ttlSeconds = 90 + 600 + 60 = 750. Jump far past it.
        jest.setSystemTime(new Date(Date.now() + 10_000 * 1000));
        const verdict = await room.evaluate({
          cookie,
          bindings: { sessionId: "s-1", shop: "demo" },
        });
        expect(verdict.action).toBe("wait");
        if (verdict.action !== "wait") return;
        expect(verdict.cookie).not.toBe(cookie);
      } finally {
        jest.useRealTimers();
      }
    });

    it("returns wait with a fresh cookie when bindings mismatch", async () => {
      const room = makeRoom();
      const cookie = room.issueActive({ sessionId: "s-1", shop: "demo" });
      const verdict = await room.evaluate({
        cookie,
        bindings: { sessionId: "s-1", shop: "other-shop" },
      });
      expect(verdict.action).toBe("wait");
      if (verdict.action !== "wait") return;
      expect(verdict.cookie).not.toBe(cookie);
    });
  });

  describe("admissionCap", () => {
    it("admits and increments the counter when under cap", async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const store = new InMemoryAdmissionStore();
        const room = makeRoomWithCap(store, 2, 60);
        const waitCookie = room.issueWaiting({ sessionId: "s-1", shop: "demo" });
        jest.setSystemTime(new Date(Date.now() + 91 * 1000));

        const verdict = await room.evaluate({
          cookie: waitCookie,
          bindings: { sessionId: "s-1", shop: "demo" },
        });
        expect(verdict.action).toBe("admit");
        const slotIdx = Math.floor(Math.floor(Date.now() / 1000) / 60);
        expect(store.count(String(slotIdx))).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it("bumps to next slot when at cap, leaving counter unchanged", async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const store = new InMemoryAdmissionStore();
        const room = makeRoomWithCap(store, 1, 60);
        // Pre-fill the slot to its cap.
        const slotIdx = Math.floor(Math.floor(Date.now() / 1000 + 91) / 60);
        await store.tryAdmit(String(slotIdx), 1);
        expect(store.count(String(slotIdx))).toBe(1);

        const waitCookie = room.issueWaiting({ sessionId: "s-1", shop: "demo" });
        jest.setSystemTime(new Date(Date.now() + 91 * 1000));

        const verdict = await room.evaluate({
          cookie: waitCookie,
          bindings: { sessionId: "s-1", shop: "demo" },
        });
        expect(verdict.action).toBe("wait");
        if (verdict.action !== "wait") return;
        expect(verdict.cookie).not.toBe(waitCookie);
        expect(verdict.entryAt).toBe((slotIdx + 1) * 60);
        expect(store.count(String(slotIdx))).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it("uses a separate counter per slot across rollover", async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const store = new InMemoryAdmissionStore();
        const room = makeRoomWithCap(store, 5, 60);

        const cookieA = room.issueWaiting({ sessionId: "s-1", shop: "demo" });
        jest.setSystemTime(new Date(Date.now() + 91 * 1000));
        const slotA = String(Math.floor(Math.floor(Date.now() / 1000) / 60));
        await room.evaluate({
          cookie: cookieA,
          bindings: { sessionId: "s-1", shop: "demo" },
        });
        expect(store.count(slotA)).toBe(1);

        // Jump ahead a full slot.
        jest.setSystemTime(new Date(Date.now() + 60 * 1000));
        const cookieB = room.issueWaiting({ sessionId: "s-2", shop: "demo" });
        jest.setSystemTime(new Date(Date.now() + 91 * 1000));
        const slotB = String(Math.floor(Math.floor(Date.now() / 1000) / 60));
        await room.evaluate({
          cookie: cookieB,
          bindings: { sessionId: "s-2", shop: "demo" },
        });
        expect(slotB).not.toBe(slotA);
        expect(store.count(slotB)).toBe(1);
        expect(store.count(slotA)).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it("fail-open: admits when the store throws", async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const store = new InMemoryAdmissionStore();
        const room = makeRoomWithCap(store, 1, 60);

        const waitCookie = room.issueWaiting({ sessionId: "s-1", shop: "demo" });
        jest.setSystemTime(new Date(Date.now() + 91 * 1000));
        const slotIdx = Math.floor(Math.floor(Date.now() / 1000) / 60);
        store.triggerError(String(slotIdx));

        const verdict = await room.evaluate({
          cookie: waitCookie,
          bindings: { sessionId: "s-1", shop: "demo" },
        });
        expect(verdict.action).toBe("admit");
      } finally {
        jest.useRealTimers();
      }
    });

    it("fail-closed: bumps when the store throws", async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const store = new InMemoryAdmissionStore();
        const room = makeRoomWithCap(store, 1, 60, "closed");

        const waitCookie = room.issueWaiting({ sessionId: "s-1", shop: "demo" });
        jest.setSystemTime(new Date(Date.now() + 91 * 1000));
        const slotIdx = Math.floor(Math.floor(Date.now() / 1000) / 60);
        store.triggerError(String(slotIdx));

        const verdict = await room.evaluate({
          cookie: waitCookie,
          bindings: { sessionId: "s-1", shop: "demo" },
        });
        expect(verdict.action).toBe("wait");
      } finally {
        jest.useRealTimers();
      }
    });

    it("regression: behaviour unchanged when admissionCap is not configured", async () => {
      // Identical to the basic admit case, repeated here to lock in that
      // adding the cap option didn't shift the no-cap default.
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const room = makeRoom();
        const waitCookie = room.issueWaiting({ sessionId: "s-1", shop: "demo" });
        jest.setSystemTime(new Date(Date.now() + 91 * 1000));

        const verdict = await room.evaluate({
          cookie: waitCookie,
          bindings: { sessionId: "s-1", shop: "demo" },
        });
        expect(verdict.action).toBe("admit");
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

