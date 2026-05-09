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
