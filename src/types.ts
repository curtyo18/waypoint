export type WaitSeconds = {
  min: number;
  max: number;
};

export type JitterFn = (sessionId: string, min: number, max: number) => number;

export type WaypointOptions = {
  secret: string;
  waitSeconds: WaitSeconds;
  activeSeconds: number;
  purpose?: string;
  jitter?: JitterFn;
  cookieName?: string;
  cookieDomain?: string;
  cookiePath?: string;
  admissionCap?: AdmissionCapOptions;
  lottery?: LotteryOptions;
};

/**
 * One-shot bimodal lottery. Optional opt-in.
 *
 * At cookie issuance, each session is independently assigned to either the
 * "lucky" bucket (probability `luckyChance`) or the regular bucket. Lucky
 * sessions get their wait drawn from `luckyWaitSeconds`; everyone else
 * uses the regular `waitSeconds` range. The decision is deterministic per
 * session-and-day via HMAC, so reloading doesn't re-roll.
 *
 * The lottery is intentionally one-shot: it changes the *distribution* of
 * waits, not the admission protocol. There is no per-attempt retry — each
 * user gets a single deterministic countdown like the plain splay buffer.
 *
 * Recommended when you want a realistic queue UX where a small fraction of
 * arrivals are fast-tracked while the bulk get a longer (still bounded)
 * wait. Sized so that *both buckets* spread admissions under origin
 * capacity — see the README for the math.
 */
export type LotteryOptions = {
  /** Probability in (0, 1) that any given session is assigned to the lucky bucket. */
  luckyChance: number;
  /** Wait window for lucky sessions. Should be sized so that
   *  `luckyArrivals / (luckyWaitSeconds.max - luckyWaitSeconds.min)` stays
   *  under origin capacity. */
  luckyWaitSeconds: WaitSeconds;
};

/**
 * Atomic per-slot counter store for the optional admission cap.
 *
 * `tryAdmit(slot, cap)` MUST atomically: read the current count for `slot`,
 * compare to `cap`, and if under-cap increment-and-return-true; otherwise
 * return-false-without-incrementing. Two concurrent callers observing the
 * same `slot` must not both push the underlying counter above `cap` —
 * that's the contract the admission cap is built on.
 *
 * Eventually-consistent stores (multi-region KV, replicated caches) may
 * overshoot, bounded by their consistency window. That overshoot is the
 * operator's trade-off, not a waypoint bug; document it and pick `perSlot`
 * accordingly.
 */
export type AdmissionStore = {
  tryAdmit(slot: string, cap: number): Promise<boolean>;
};

export type AdmissionCapOptions = {
  perSlot: number;
  slotSeconds: number;
  store: AdmissionStore;
  /**
   * What to do if `store.tryAdmit` throws. `"open"` (default) admits the
   * caller — favours availability. `"closed"` treats the throw as a "full"
   * answer and bumps the visitor to the next slot — favours the cap.
   */
  onStoreError?: "open" | "closed";
};

export type WaitingState = {
  state: "waiting";
  entryAt: number;
};

export type ActiveState = {
  state: "active";
  /** Unix timestamp (seconds) at which the active session ends. The cookie's
   *  underlying waypass `exp` is sized to cover the maximum possible cookie
   *  lifetime; `exitAt` enforces the configured `activeSeconds` cleanly. */
  exitAt: number;
};

export type CookieData = WaitingState | ActiveState;

/**
 * Reasons `verify` can return on failure. Same vocabulary as waypass's
 * `VerifyReason` plus the `malformed` case for when the cookie's `data`
 * field doesn't match the expected `CookieData` shape.
 */
export type VerifyReason =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "purpose_mismatch"
  | "bindings_mismatch"
  | "replayed";

export type VerifyResult =
  | { ok: true; state: "waiting"; entryAt: number }
  | { ok: true; state: "active"; exitAt: number }
  | { ok: false; reason: VerifyReason };

export type WaitVerdict = {
  action: "wait";
  cookie: string;
  entryAt: number;
};

export type AdmitVerdict = {
  action: "admit";
  cookie: string;
};

export type PassVerdict = {
  action: "pass";
};

export type Verdict = WaitVerdict | AdmitVerdict | PassVerdict;

export type EvaluateInput<TUserBindings extends Record<string, string>> = {
  cookie: string | undefined;
  bindings: TUserBindings & { sessionId: string };
};
