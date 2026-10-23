// Amazon Connect as a phone line. Connect places the real call and does the
// voice (neural voice out, Amazon Lex speech-to-text in). Each turn, the
// contact flow's Lambda posts what the person said to /connect/turn, and we
// answer with what CallAssist says next, from the same conversation engine the
// local phones use.
import { ConnectClient, StartOutboundVoiceContactCommand, StartWebRTCContactCommand, StopContactCommand } from "@aws-sdk/client-connect";
import type { CallRecord } from "./store.js";
import type { LocalPhoneNetwork, PhoneEvents, Telephony } from "./telephony.js";

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
  /** Browser calling: a Connect voice contact over WebRTC, no phone number needed. */
  startWebCall?(input: { displayName: string; attributes: Record<string, string> }): Promise<{ contactId: string; connectionData: unknown }>;
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
    async startWebCall({ displayName, attributes }) {
      const out = await client.send(
        new StartWebRTCContactCommand({
          InstanceId: s.instanceId,
          ContactFlowId: s.contactFlowId,
          ParticipantDetails: { DisplayName: displayName.slice(0, 256) },
          Attributes: attributes,
        }),
      );
      return { contactId: out.ContactId ?? "", connectionData: out.ConnectionData };
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
  readonly name: string = "amazon-connect";
  protected events?: PhoneEvents;
  protected queued = new Map<string, string[]>();
  protected ended = new Set<string>();
  protected contacts = new Map<string, string>();

  constructor(protected api: ConnectApi, protected log: (e: Record<string, unknown>) => void = () => {}) {}

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

  protected inTurn = new Set<string>();
  private silent = new Map<string, number>();
  private lastSaid = new Map<string, string>();

  /** One turn from the contact flow. The engine is synchronous, so its reply is ready right after. */
  turn(callId: string, event: "answered" | "heard" | "hangup", text = ""): TurnResult {
    if (!this.queued.has(callId)) this.queued.set(callId, []);
    this.inTurn.add(callId);
    try {
      if (event === "answered") this.events?.answered(callId);
      else if (event === "heard") {
        if (text.trim()) {
          this.silent.delete(callId);
          this.events?.heard(callId, text);
        } else if (!this.ended.has(callId)) {
          // Silence: ask the last question again once; after that the conversation decides (retry later, etc.).
          const n = (this.silent.get(callId) ?? 0) + 1;
          this.silent.set(callId, n);
          if (n === 1) this.queued.get(callId)!.push(`Sorry, I didn't catch that. ${lastQuestion(this.lastSaid.get(callId) ?? "")}`);
          else this.events?.silent?.(callId);
        }
      } else this.events?.hungUp(callId, "contact");
    } finally {
      this.inTurn.delete(callId);
    }
    const lines = this.queued.get(callId) ?? [];
    this.queued.set(callId, []);
    if (lines.length) this.lastSaid.set(callId, lines.join(" "));
    const end = event === "hangup" || this.ended.has(callId);
    if (end) this.cleanup(callId);
    return { say: lines.join(" "), end };
  }

  protected cleanup(callId: string): void {
    this.queued.delete(callId);
    this.silent.delete(callId);
    this.lastSaid.delete(callId);
    this.contacts.delete(callId);
    setTimeout(() => this.ended.delete(callId), 60_000).unref?.();
  }
}

/** The last question in what was just said, to repeat after silence. */
function lastQuestion(said: string): string {
  const questions = said.match(/[^.!?]*\?/g);
  return questions?.length ? questions[questions.length - 1].trim() : "Could you say that again?";
}

/**
 * Browser calling through Amazon Connect. The worker's phone page rings (no
 * phone number involved); on Accept the page asks us to start a Connect
 * WebRTC contact and joins its audio. From then on it is the same Connect
 * flow, Lex bot, Lambda and /connect/turn conversation as a phone call.
 */
export class ConnectWebCallTelephony extends ConnectTelephony {
  readonly name = "amazon-connect-web";
  private callContact = new Map<string, string>();

  constructor(api: ConnectApi, private phones: LocalPhoneNetwork, log: (e: Record<string, unknown>) => void = () => {}) {
    super(api, log);
  }

  ring(call: CallRecord): void {
    this.queued.set(call.id, []);
    this.callContact.set(call.id, call.contactId);
    this.phones.signal(call.contactId, { type: "incoming", callId: call.id, from: "CallAssist", purpose: call.purpose, via: "connect-web" });
  }

  owns(callId: string): boolean {
    return this.callContact.has(callId) || this.queued.has(callId);
  }

  /** The worker tapped Accept: start the Connect contact and hand the page its audio connection. */
  async accept(callId: string, displayName: string): Promise<{ connectionData: unknown }> {
    if (!this.api.startWebCall) throw new Error("browser calling not available");
    if (!this.callContact.has(callId)) throw new Error("unknown or finished call");
    const { contactId, connectionData } = await this.api.startWebCall({ displayName, attributes: { callId, purpose: "web" } });
    this.contacts.set(callId, contactId);
    this.log({ event: "connect_web_call_started", callId, contactId });
    return { connectionData };
  }

  /** The worker hung up on the page: end the Connect contact too. */
  endFromPage(callId: string): void {
    const contactId = this.contacts.get(callId);
    if (contactId) this.api.stopCall(contactId).catch(() => {});
    this.contacts.delete(callId);
  }

  speak(callId: string, text: string): void {
    super.speak(callId, text);
    const contactId = this.callContact.get(callId);
    if (contactId) this.phones.signal(contactId, { type: "caption", callId, who: "assistant", text });
  }

  turn(callId: string, event: "answered" | "heard" | "hangup", text = ""): TurnResult {
    const contactId = this.callContact.get(callId);
    if (event === "heard" && text.trim() && contactId) this.phones.signal(contactId, { type: "caption", callId, who: "contact", text });
    const r = super.turn(callId, event, text);
    if (r.end && contactId) setTimeout(() => this.phones.signal(contactId, { type: "hangup", callId, reason: "ended" }), 8000).unref?.();
    return r;
  }

  hangUp(callId: string, reason: string): void {
    super.hangUp(callId, reason);
    const contactId = this.callContact.get(callId);
    if (contactId && !this.contacts.has(callId)) this.phones.signal(contactId, { type: "hangup", callId, reason });
    this.callContact.delete(callId);
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
