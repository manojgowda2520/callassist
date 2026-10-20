// Telephony: the "media" layer that rings a phone and carries voice. The
// assistant only uses this interface, so the local phone network and Amazon
// Connect are interchangeable.
import { EventEmitter } from "node:events";
import type { CallRecord } from "./store.js";

export interface PhoneEvents {
  /** The person picked up. */
  answered(callId: string): void;
  /** The person said something (speech already turned into text). */
  heard(callId: string, text: string): void;
  /** The person rejected the call or hung up. */
  hungUp(callId: string, byWho: "contact"): void;
}

export interface Telephony {
  readonly name: string;
  /** Start ringing the contact's phone. */
  ring(call: CallRecord): void;
  /** Speak one line to the person on the call. */
  speak(callId: string, text: string): void;
  /** End the call from our side. */
  hangUp(callId: string, reason: string): void;
  /** Wire up the events coming back from the phone. */
  connect(events: PhoneEvents): void;
}

export type PhoneSignal =
  | { type: "incoming"; callId: string; from: string; purpose: string }
  | { type: "say"; callId: string; text: string; audio?: string }
  | { type: "hangup"; callId: string; reason: string }
  | { type: "outgoing_connected"; callId: string };

/**
 * Local phone network. Each contact's phone page (/phone/:contactId) listens
 * here; tests attach the same way. Nothing leaves this machine.
 */
export class LocalPhoneNetwork implements Telephony {
  readonly name = "local-phone-network";
  private bus = new EventEmitter();
  private events?: PhoneEvents;
  private callContact = new Map<string, string>();

  constructor(private audioUrl?: (text: string) => string | undefined) {
    this.bus.setMaxListeners(100);
  }

  connect(events: PhoneEvents): void {
    this.events = events;
  }

  ring(call: CallRecord): void {
    this.callContact.set(call.id, call.contactId);
    this.send(call.contactId, { type: "incoming", callId: call.id, from: "CallAssist", purpose: call.purpose });
  }

  speak(callId: string, text: string): void {
    const contactId = this.callContact.get(callId);
    if (contactId) this.send(contactId, { type: "say", callId, text, audio: this.audioUrl?.(text) });
  }

  hangUp(callId: string, reason: string): void {
    const contactId = this.callContact.get(callId);
    if (contactId) this.send(contactId, { type: "hangup", callId, reason });
    this.callContact.delete(callId);
  }

  /** Register an inbound call (the worker phoning CallAssist) so we can talk back. */
  attachInbound(callId: string, contactId: string): void {
    this.callContact.set(callId, contactId);
    this.send(contactId, { type: "outgoing_connected", callId });
  }

  // ---- the phone side (phone page, tests) ----

  /** Listen to everything sent to one contact's phone. */
  listen(contactId: string, fn: (s: PhoneSignal) => void): () => void {
    this.bus.on(contactId, fn);
    return () => this.bus.off(contactId, fn);
  }

  listeners(contactId: string): number {
    return this.bus.listenerCount(contactId);
  }

  answer(callId: string): void {
    this.events?.answered(callId);
  }

  say(callId: string, text: string): void {
    this.events?.heard(callId, text);
  }

  reject(callId: string): void {
    this.events?.hungUp(callId, "contact");
    this.callContact.delete(callId);
  }

  private send(contactId: string, s: PhoneSignal): void {
    this.bus.emit(contactId, s);
  }
}
