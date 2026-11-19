export interface Policy {
  name: string;
  quota: number;
  windowSeconds: number;
}

export interface Reply {
  status: number;
  headers: Record<string, string>; // lowercase names
  body?: unknown;
}

export type Transport<Req> = (req: Req) => Promise<Reply>;

/** `"api";q=1000;w=60, "api-heavy";q=120;w=60` */
export function parsePolicies(header: string | undefined): Policy[] {
  if (!header) return [];
  const out: Policy[] = [];
  for (const item of header.split(/,(?=\s*")/)) {
    const name = /^\s*"([^"]+)"/.exec(item)?.[1];
    const q = /;\s*q=(\d+)/.exec(item)?.[1];
    const w = /;\s*w=(\d+)/.exec(item)?.[1];
    if (name && q && w) out.push({ name, quota: Number(q), windowSeconds: Number(w) });
  }
  return out;
}

/** 429 `Retry-After` is seconds (the docs never show an HTTP-date form). */
export function retryAfterMs(reply: Reply): number {
  const ra = Number(reply.headers['retry-after']);
  if (Number.isFinite(ra) && ra >= 0) return ra * 1000;
  const t = /;\s*t=(\d+)/.exec(reply.headers['ratelimit'] ?? '')?.[1];
  return t ? Number(t) * 1000 : 1000;
}

/**
 * Sliding-window log: at most `capacity` takes in any `windowMs`. Matches the server's documented sliding window,
 * so an agent given 10% of the budget never exceeds 10% in any window (a refilling token bucket can burst to ~2x).
 */
export class Bucket {
  capacity: number;
  windowMs: number;
  private log: number[] = [];
  constructor(capacity: number, windowMs: number, _now: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.windowMs = windowMs;
  }
  resize(capacity: number, windowMs: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.windowMs = windowMs;
  }
  /** ms until a slot is free, 0 when one is taken now */
  take(now: number): number {
    while (this.log.length && this.log[0] <= now - this.windowMs) this.log.shift();
    if (this.log.length < this.capacity) {
      this.log.push(now);
      return 0;
    }
    return this.log[this.log.length - this.capacity] + this.windowMs - now;
  }
  /** give back a slot that was taken but not spent */
  refund() {
    this.log.pop();
  }
}

export interface GuardOptions<Req> {
  /** Fraction of the account budget this agent may use, 0..1. All credentials of an account share one budget. */
  share: number;
  /** Policy assumed until the first response reveals the real one (docs: api = 1000 per 60s, times plan). */
  defaultPolicies?: Policy[];
  /** Which extra policies a request also spends (e.g. api-heavy for compare/blame/search/diff). */
  extraPolicies?: (req: Req) => string[];
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (info: { policy: string; ms: number; reason: 'bucket' | '429' }) => void;
}

export interface GuardStats {
  requests: number;
  waits: number;
  waitedMs: number;
  throttled429: number;
  policies: Policy[];
}

export function createGuard<Req>(transport: Transport<Req>, opts: GuardOptions<Req>) {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 3;
  const buckets = new Map<string, Bucket>();
  const policies = new Map<string, Policy>();
  let blockedUntil = 0;
  let consecutive429 = 0;
  // until one response reveals the real policy, only a single probe request may fly
  let probe: Promise<void> | undefined;
  let learnedOnce = false;
  const stats: GuardStats = { requests: 0, waits: 0, waitedMs: 0, throttled429: 0, policies: [] };

  const learn = (p: Policy) => {
    policies.set(p.name, p);
    const cap = p.quota * opts.share;
    const b = buckets.get(p.name);
    if (b) b.resize(cap, p.windowSeconds * 1000);
    else buckets.set(p.name, new Bucket(cap, p.windowSeconds * 1000, now()));
  };
  for (const p of opts.defaultPolicies ?? [{ name: 'api', quota: 1000, windowSeconds: 60 }]) learn(p);

  const wait = async (ms: number, policy: string, reason: 'bucket' | '429') => {
    stats.waits++;
    stats.waitedMs += ms;
    opts.onWait?.({ policy, ms, reason });
    await sleep(ms);
  };

  // serialize acquisition so concurrent callers of one agent cannot overshoot the bucket
  let chain: Promise<void> = Promise.resolve();
  const acquire = (names: string[]) => {
    const run = chain.then(async () => {
      for (;;) {
        const now0 = now();
        if (blockedUntil > now0) {
          await wait(blockedUntil - now0, 'account', '429');
          continue;
        }
        const taken: Bucket[] = [];
        let need = 0;
        let who = '';
        for (const n of names) {
          const b = buckets.get(n);
          if (!b) continue;
          const ms = b.take(now0);
          if (ms > 0) {
            need = ms;
            who = n;
            break;
          }
          taken.push(b);
        }
        if (!need) return;
        taken.forEach((b) => b.refund());
        await wait(need, who, 'bucket');
      }
    });
    chain = run.catch(() => {});
    return run;
  };

  return {
    async request(req: Req): Promise<Reply> {
      let release: (() => void) | undefined;
      if (!learnedOnce) {
        if (probe) await probe;
        if (!learnedOnce && !probe) probe = new Promise<void>((r) => (release = r));
        else if (probe && !learnedOnce) await probe;
      }
      try {
        return await send(req);
      } finally {
        if (release) {
          learnedOnce = true;
          release();
        }
      }
    },
    stats: (): GuardStats => ({ ...stats, policies: [...policies.values()] }),
  };

  async function send(req: Req): Promise<Reply> {
      for (let attempt = 0; ; attempt++) {
        await acquire(['api', ...(opts.extraPolicies?.(req) ?? [])]);
        stats.requests++;
        const reply = await transport(req);
        const seen = parsePolicies(reply.headers['ratelimit-policy']);
        seen.forEach(learn);
        if (seen.length) {
          stats.policies = [...policies.values()];
          learnedOnce = true;
        }
        if (reply.status !== 429) {
          consecutive429 = 0;
          return reply;
        }
        stats.throttled429++;
        consecutive429++;
        // the budget is account-wide, so pause every request of this agent, not just this one; back off when repeated
        const ms = retryAfterMs(reply) * Math.min(2 ** (consecutive429 - 1), 8) + Math.floor(Math.random() * 250);
        blockedUntil = Math.max(blockedUntil, now() + ms);
        if (attempt >= maxRetries) return reply;
      }
  }
}
