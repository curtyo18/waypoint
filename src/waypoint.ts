import { Waypass } from "waypass";
import type { TokenPayload } from "waypass";
import { defaultJitter } from "./jitter.js";
import type {
  AdmissionCapOptions,
  CookieData,
  EvaluateInput,
  JitterFn,
  Verdict,
  VerifyResult,
  WaitSeconds,
  WaypointOptions,
} from "./types.js";

const GRACE_SECONDS = 60;

export class Waypoint<TUserBindings extends Record<string, string> = Record<string, string>> {
  public readonly cookieName: string;
  public readonly cookieDomain: string | undefined;
  public readonly cookiePath: string;

  private readonly tokens: Waypass<TUserBindings & { sessionId: string }>;
  private readonly waitSeconds: WaitSeconds;
  private readonly activeSeconds: number;
  private readonly jitter: JitterFn;
  private readonly admissionCap: AdmissionCapOptions | undefined;

  constructor(opts: WaypointOptions) {
    if (opts.waitSeconds.min < 0 || opts.waitSeconds.max < opts.waitSeconds.min) {
      throw new Error("waypoint: waitSeconds must satisfy 0 <= min <= max");
    }
    if (opts.activeSeconds <= 0) {
      throw new Error("waypoint: activeSeconds must be > 0");
    }

    this.waitSeconds = opts.waitSeconds;
    this.activeSeconds = opts.activeSeconds;
    this.jitter = opts.jitter ?? defaultJitter(opts.secret);
    this.cookieName = opts.cookieName ?? "waypoint";
    this.cookieDomain = opts.cookieDomain;
    this.cookiePath = opts.cookiePath ?? "/";
    this.admissionCap = opts.admissionCap;
    if (this.admissionCap && this.admissionCap.slotSeconds <= 0) {
      throw new Error("waypoint: admissionCap.slotSeconds must be > 0");
    }
    if (this.admissionCap && this.admissionCap.perSlot <= 0) {
      throw new Error("waypoint: admissionCap.perSlot must be > 0");
    }

    const ttlSeconds = opts.waitSeconds.max + opts.activeSeconds + GRACE_SECONDS;
    this.tokens = new Waypass<TUserBindings & { sessionId: string }>({
      secret: opts.secret,
      purpose: opts.purpose ?? "waypoint",
      ttlSeconds,
    });
  }

  public issueWaiting(bindings: TUserBindings & { sessionId: string }): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const wait = this.jitter(bindings.sessionId, this.waitSeconds.min, this.waitSeconds.max);
    const entryAt = nowSec + wait;
    const data: CookieData = { state: "waiting", entryAt };
    return this.tokens.create(bindings, data);
  }

  public issueActive(bindings: TUserBindings & { sessionId: string }): string {
    const data: CookieData = { state: "active" };
    return this.tokens.create(bindings, data);
  }

  public verify(
    cookieValue: string,
    bindings: TUserBindings & { sessionId: string },
  ): VerifyResult {
    const result = this.tokens.verify(cookieValue, bindings);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    const data = (result.payload as TokenPayload).data as CookieData | undefined;
    if (!data || (data.state !== "waiting" && data.state !== "active")) {
      return { ok: false, reason: "malformed" };
    }
    if (data.state === "waiting") {
      return { ok: true, state: "waiting", entryAt: data.entryAt };
    }
    return { ok: true, state: "active" };
  }

  public async evaluate(input: EvaluateInput<TUserBindings>): Promise<Verdict> {
    const { cookie, bindings } = input;

    // No cookie, or any verification failure (bad sig, expired, bindings
    // mismatch, malformed payload), funnels to a fresh wait. v1 does not
    // distinguish "kickback after admission" from "fresh visitor on a
    // stale cookie": waypass's verify() doesn't expose the payload on the
    // expired path, so we'd be guessing. The kickback action label can be
    // added once that distinction is observable.
    const verified = cookie === undefined ? undefined : this.verify(cookie, bindings);
    if (!verified || !verified.ok) {
      return this.freshWait(bindings);
    }

    if (verified.state === "active") {
      return { action: "pass" };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < verified.entryAt) {
      return { action: "wait", cookie: cookie!, entryAt: verified.entryAt };
    }

    return this.tryAdmitWithCap(bindings, nowSec);
  }

  protected async tryAdmitWithCap(
    bindings: TUserBindings & { sessionId: string },
    nowSec: number,
  ): Promise<Verdict> {
    if (!this.admissionCap) {
      return this.admit(bindings);
    }

    const { perSlot, slotSeconds, store, onStoreError } = this.admissionCap;
    const slotIdx = Math.floor(nowSec / slotSeconds);
    const slot = String(slotIdx);

    let admitted: boolean;
    try {
      admitted = await store.tryAdmit(slot, perSlot);
    } catch (_err) {
      // Operator picks the failure mode. Default ("open") favours
      // availability — let people in if the counter store is unhappy.
      admitted = onStoreError === "closed" ? false : true;
    }

    if (admitted) {
      return this.admit(bindings);
    }

    const nextEntryAt = (slotIdx + 1) * slotSeconds;
    const data: CookieData = { state: "waiting", entryAt: nextEntryAt };
    const bumpedCookie = this.tokens.create(bindings, data);
    return { action: "wait", cookie: bumpedCookie, entryAt: nextEntryAt };
  }

  protected freshWait(bindings: TUserBindings & { sessionId: string }): Verdict {
    const cookie = this.issueWaiting(bindings);
    const verified = this.verify(cookie, bindings);
    // Just-issued, our own signature — the only way verify could fail here
    // is a programmer error. Surface it loudly.
    if (!verified.ok || verified.state !== "waiting") {
      throw new Error("waypoint: failed to round-trip a freshly-issued waiting cookie");
    }
    return { action: "wait", cookie, entryAt: verified.entryAt };
  }

  protected admit(bindings: TUserBindings & { sessionId: string }): Verdict {
    const cookie = this.issueActive(bindings);
    return { action: "admit", cookie };
  }
}
