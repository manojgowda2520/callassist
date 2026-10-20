// Operations: metrics and rate limits.
// Metrics are written as CloudWatch Embedded Metric Format (EMF) log lines, so
// on AWS they become CloudWatch metrics with no extra code; locally they also
// feed /api/metrics for the console.
import type { Request, Response, NextFunction } from "express";

export class Metrics {
  private counters = new Map<string, number>();
  private latencies = new Map<string, number[]>();

  constructor(private emit: (line: Record<string, unknown>) => void = () => {}, private namespace = "CallAssist") {}

  count(name: string, value = 1, dims: Record<string, string> = {}): void {
    const key = [name, ...Object.entries(dims).map(([k, v]) => `${k}=${v}`)].join("|");
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
    this.emf(name, value, "Count", dims);
  }

  timing(name: string, ms: number, dims: Record<string, string> = {}): void {
    const key = [name, ...Object.entries(dims).map(([k, v]) => `${k}=${v}`)].join("|");
    const list = this.latencies.get(key) ?? [];
    list.push(ms);
    if (list.length > 500) list.shift();
    this.latencies.set(key, list);
    this.emf(name, ms, "Milliseconds", dims);
  }

  snapshot() {
    const pct = (xs: number[], p: number) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
    };
    return {
      counters: Object.fromEntries(this.counters),
      latency: Object.fromEntries([...this.latencies].map(([k, xs]) => [k, { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(0, ...xs) }])),
    };
  }

  private emf(name: string, value: number, unit: string, dims: Record<string, string>): void {
    const keys = Object.keys(dims);
    this.emit({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: this.namespace, Dimensions: [keys], Metrics: [{ Name: name, Unit: unit }] }] },
      ...dims,
      [name]: value,
    });
  }
}

/** A simple token bucket per client address. On AWS, API Gateway / WAF do this. */
export function rateLimit(opts: { perMinute: number; burst?: number; name: string; onLimit?: (key: string) => void }) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const cap = opts.burst ?? opts.perMinute;
  const refill = opts.perMinute / 60_000;
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + (now - b.at) * refill);
    b.at = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      opts.onLimit?.(key);
      res.status(429).set("retry-after", String(Math.ceil((1 - b.tokens) / refill / 1000))).json({ error: "rate_limited", error_description: `Too many requests to ${opts.name}. Try again shortly.` });
      return;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.clear();
    next();
  };
}
