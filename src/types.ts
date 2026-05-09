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
};

export type CookieData = WaitingState | ActiveState;

export type VerifyResult =
  | { ok: true; state: "waiting"; entryAt: number }
  | { ok: true; state: "active" }
  | { ok: false; reason: string };

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
