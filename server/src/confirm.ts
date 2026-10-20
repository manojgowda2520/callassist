// Server-checked confirmation (OWASP LLM06, "excessive agency").
// A read-back returns a one-time confirmationToken bound to exactly what was
// read back. The action only runs when that token comes back unchanged, so a
// model can't skip the read-back or swap the person or message after the user
// said yes. The token doubles as an idempotency key: if Alexa+ retries the same
// confirmed call, the first result is returned and nobody is called twice.
import { randomBytes } from "node:crypto";

interface Pending {
  tool: string;
  fingerprint: string;
  owner: string;
  expiresAt: number;
  result?: { taskId: string };
}

export type ConfirmCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "unknown" | "expired" | "mismatch" }
  | { ok: "replay"; taskId: string };

export class Confirmations {
  private pending = new Map<string, Pending>();

  constructor(private ttlMs = 5 * 60_000) {}

  issue(tool: string, fingerprint: string, owner = "default"): string {
    this.sweep();
    const token = `cf_${randomBytes(12).toString("base64url")}`;
    this.pending.set(token, { tool, fingerprint, owner, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  check(tool: string, fingerprint: string, token: string | undefined, owner = "default"): ConfirmCheck {
    if (!token) return { ok: false, reason: "missing" };
    const p = this.pending.get(token);
    if (!p) return { ok: false, reason: "unknown" };
    if (p.tool !== tool || p.fingerprint !== fingerprint || p.owner !== owner) return { ok: false, reason: "mismatch" };
    if (p.result) return { ok: "replay", taskId: p.result.taskId };
    if (p.expiresAt < Date.now()) return { ok: false, reason: "expired" };
    return { ok: true };
  }

  /** Mark the token used, remembering the result for retries. */
  complete(token: string, taskId: string): void {
    const p = this.pending.get(token);
    if (p) {
      p.result = { taskId };
      p.expiresAt = Date.now() + 30 * 60_000; // keep for retries
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
  }
}
