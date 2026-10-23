// SIP line (India testing): calls go out through Mobil80's Asterisk + Airtel
// trunk. A small bridge program runs next to Asterisk and connects OUT to us
// over HTTPS; we never reach into the PBX. The bridge receives "call" jobs on
// /sip/events, drives Asterisk through ARI, and posts each turn to /sip/turn.
// The conversation itself is the same engine as Amazon Connect and the demo phones.
import type { Response } from "express";
import { ConnectTelephony, type ConnectApi } from "./connect.js";

/** opening: what CallAssist says first, so the bridge can make the audio while the phone rings. */
export type BridgeJob = { type: "call"; callId: string; phone: string; purpose: string; opening?: string } | { type: "hangup"; callId: string };

/** Holds the connected bridge(s) and hands them jobs. Doubles as the line's "API". */
export class SipBroker implements ConnectApi {
  private bridges = new Set<(job: BridgeJob) => void>();

  get connected(): number {
    return this.bridges.size;
  }

  /** A bridge connected to /sip/events. */
  attach(res: Response): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": bridge connected\n\n");
    const send = (job: BridgeJob) => res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    this.bridges.add(send);
    res.on("close", () => {
      clearInterval(ping);
      this.bridges.delete(send);
    });
  }

  /** For tests: subscribe like a bridge would. */
  subscribe(fn: (job: BridgeJob) => void): () => void {
    this.bridges.add(fn);
    return () => this.bridges.delete(fn);
  }

  private send(job: BridgeJob): void {
    // One bridge takes each job; with several connected, the first one wins.
    const first = this.bridges.values().next().value;
    if (!first) throw new Error("no SIP bridge connected");
    first(job);
  }

  async startCall({ destination, attributes }: { destination: string; attributes: Record<string, string> }) {
    this.send({ type: "call", callId: attributes.callId, phone: destination, purpose: attributes.purpose ?? "assign", opening: attributes.opening });
    return { contactId: attributes.callId };
  }

  async stopCall(contactId: string) {
    if (this.bridges.size) this.send({ type: "hangup", callId: contactId });
  }
}

export class SipTelephony extends ConnectTelephony {
  readonly name = "airtel-sip";

  constructor(readonly broker: SipBroker, log: (e: Record<string, unknown>) => void = () => {}) {
    super(broker, log);
  }

  owns(callId: string): boolean {
    return this.queued.has(callId) || this.contacts.has(callId);
  }
}
