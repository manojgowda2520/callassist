// Amazon Connect as a phone line. Connect places the real call and does the
// voice (neural voice out, Amazon Lex speech-to-text in). Each turn, the
// contact flow's Lambda posts what the person said to /connect/turn, and we
// answer with what CallAssist says next, from the same conversation engine the
// local phones use.
import { ConnectClient, StartOutboundVoiceContactCommand, StopContactCommand } from "@aws-sdk/client-connect";
import type { CallRecord } from "./store.js";
import type { PhoneEvents, Telephony } from "./telephony.js";

export interface ConnectSettings {
  region: string;
  instanceId: string;
  contactFlowId: string;
  /** The claimed US number calls come from (E.164). */
  sourcePhoneNumber: string;
}

/** The two Connect API calls we use. Swappable so tests don't need AWS. */
export interface ConnectApi {
  startCall(input: { destination: string; attributes: Record<string, string> }): Promise<{ contactId: string }>;
  stopCall(contactId: string): Promise<void>;
}

export function awsConnectApi(s: ConnectSettings): ConnectApi {
  const client = new ConnectClient({ region: s.region });
  return {
    async startCall({ destination, attributes }) {
      const out = await client.send(
        new StartOutboundVoiceContactCommand({
          InstanceId: s.instanceId,
          ContactFlowId: s.contactFlowId,
          SourcePhoneNumber: s.sourcePhoneNumber,
          DestinationPhoneNumber: destination,
          Attributes: attributes,
        }),
      );
      return { contactId: out.ContactId ?? "" };
    },
    async stopCall(contactId) {
      await client.send(new StopContactCommand({ InstanceId: s.instanceId, ContactId: contactId }));
    },
  };
}

export interface TurnResult {
  /** What the contact flow should say next ("" = nothing new). */
  say: string;
  /** Hang up after saying it. */
  end: boolean;
}

export class ConnectTelephony implements Telephony {
  readonly name = "amazon-connect";
  private events?: PhoneEvents;
  private queued = new Map<string, string[]>();
  private ended = new Set<string>();
  private contacts = new Map<string, string>();

  constructor(private api: ConnectApi, private log: (e: Record<string, unknown>) => void = () => {}) {}

  connect(events: PhoneEvents): void {
    this.events = events;
  }

  ring(call: CallRecord): void {
    this.queued.set(call.id, []);
    this.api
      .startCall({ destination: call.phone, attributes: { callId: call.id, purpose: call.purpose } })
      .then(({ contactId }) => {
        this.contacts.set(call.id, contactId);
        this.log({ event: "connect_call_started", callId: call.id, contactId });
      })
      .catch((err) => {
        this.log({ event: "connect_call_failed", callId: call.id, error: String(err) });
        this.events?.hungUp(call.id, "contact");
      });
  }

  speak(callId: string, text: string): void {
    this.queued.get(callId)?.push(text);
  }

  hangUp(callId: string, _reason: string): void {
    this.ended.add(callId);
    const contactId = this.contacts.get(callId);
    // If the flow is mid-turn it will hang up itself after the last line; otherwise stop the contact.
    if (contactId && !this.inTurn.has(callId)) this.api.stopCall(contactId).catch(() => {});
  }

  private inTurn = new Set<string>();

  /** One turn from the contact flow. The engine is synchronous, so its reply is ready right after. */
  turn(callId: string, event: "answered" | "heard" | "hangup", text = ""): TurnResult {
    if (!this.queued.has(callId)) this.queued.set(callId, []);
    this.inTurn.add(callId);
    try {
      if (event === "answered") this.events?.answered(callId);
      else if (event === "heard") {
        if (text.trim()) this.events?.heard(callId, text);
        else if (!this.ended.has(callId)) this.queued.get(callId)!.push("Sorry, I didn't catch that. Could you say it again?");
      } else this.events?.hungUp(callId, "contact");
    } finally {
      this.inTurn.delete(callId);
    }
    const lines = this.queued.get(callId) ?? [];
    this.queued.set(callId, []);
    const end = event === "hangup" || this.ended.has(callId);
    if (end) this.cleanup(callId);
    return { say: lines.join(" "), end };
  }

  private cleanup(callId: string): void {
    this.queued.delete(callId);
    this.contacts.delete(callId);
    setTimeout(() => this.ended.delete(callId), 60_000).unref?.();
  }
}

/**
 * Sends each call to the right line: the local phone network (demo phones),
 * Amazon Connect (US numbers) and, later, the Airtel SIP bridge (India).
 */
export class TelephonyRouter implements Telephony {
  readonly name = "router";
  private byCall = new Map<string, Telephony>();

  constructor(private lines: Record<string, Telephony>, private pick: (call: CallRecord) => string) {}

  connect(events: PhoneEvents): void {
    for (const line of Object.values(this.lines)) line.connect(events);
  }

  ring(call: CallRecord): void {
    const line = this.lines[this.pick(call)] ?? Object.values(this.lines)[0];
    this.byCall.set(call.id, line);
    line.ring(call);
  }

  speak(callId: string, text: string): void {
    this.byCall.get(callId)?.speak(callId, text);
  }

  hangUp(callId: string, reason: string): void {
    this.byCall.get(callId)?.hangUp(callId, reason);
    this.byCall.delete(callId);
  }

  /** Inbound calls (the worker phoning CallAssist) on the local network. */
  attachInbound(callId: string, contactId: string): void {
    const local = this.lines.local as Telephony & { attachInbound?: (id: string, c: string) => void };
    this.byCall.set(callId, local);
    local.attachInbound?.(callId, contactId);
  }
}
