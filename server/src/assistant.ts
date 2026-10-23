// The personal assistant: hands tasks to the user's people by phone, runs the
// conversation, follows up, and reports back. MCP tools (what Alexa+ calls)
// and the phone-agent tools (what Amazon Connect calls) both go through here.
import { CLOSED_TASK, FINAL_CALL, type CallPurpose, type CallRecord, type Contact, type Store, type Task, type TaskKind } from "./store.js";
import type { Telephony } from "./telephony.js";
import { readWorker, type WorkerReading } from "./understand.js";
import { formatClock, type ParsedTime } from "./time.js";
import { Confirmations } from "./confirm.js";
import { renderEmail, type Mailer } from "./email.js";

export interface AssistantConfig {
  ringTimeoutMs: number;
  silenceTimeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  followUpGraceMs: number;
  maxFollowUps: number;
  maxActiveCalls: number;
  tickMs: number;
  /** Where follow-up emails go: a local outbox folder, or Amazon SES on AWS. */
  mailer?: Mailer;
  /** Closed tasks, their calls and transcripts are deleted after this many days (Policy §3). */
  retentionDays: number;
  /** Calling hours in the contact's own time zone, in minutes after midnight. null = no limit. TCPA: 8 AM–9 PM. */
  callingHours: { start: number; end: number } | null;
  /** Caps against loops and runaway cost (OWASP LLM10). Rolling 24 hours. */
  maxCallsPerContactPerDay: number;
  maxCallsPerDay: number;
}

export const DEFAULT_CONFIG: AssistantConfig = {
  ringTimeoutMs: 30_000,
  silenceTimeoutMs: 45_000,
  maxAttempts: 2,
  retryDelayMs: 60_000,
  followUpGraceMs: 60_000,
  maxFollowUps: 2,
  maxActiveCalls: 5,
  tickMs: 2_000,
  callingHours: { start: 8 * 60, end: 21 * 60 },
  maxCallsPerContactPerDay: 8,
  maxCallsPerDay: 60,
  retentionDays: 30,
};

/** Alexa+ Policy §4: never collect children's data. Tasks about kids are declined. */
export const CHILDREN = /\b(my|our|your|his|her|their|the|a) (son|daughter|sons|daughters|kid|kids|child|children|baby|babies|toddler|infant|newborn|grandson|granddaughter|grandkids?)\b|\b\d{1,2}[- ](year|yr)[- ]old\b|\b(daycare|kindergarten|preschool|nursery school|school pick ?up)\b/i;
export const EMERGENCY = /\b(911|emergency|ambulance|heart attack|stroke|overdose|suicide|fire brigade|police)\b/i;

export type Refusal = { reason: "emergency" | "children" | "no_consent" | "opted_out" | "too_many_calls" | "busy_line" | "daily_cap"; speech: string };

interface Conversation {
  purpose: CallPurpose | "inbound";
  unclear: number;
  askedEta: boolean;
  resolved: boolean;
  answer?: string;
  timers: NodeJS.Timeout[];
}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export function makeTitle(details: string): string {
  let t = clean(details).replace(/^(please |kindly )?(to )?/i, "").replace(/[.!]+$/, "");
  if (t.length > 60) t = `${t.slice(0, 57).replace(/\s+\S*$/, "")}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export class Assistant {
  readonly config: AssistantConfig;
  readonly confirmations = new Confirmations();
  private convs = new Map<string, Conversation>();
  private ticker?: NodeJS.Timeout;

  constructor(
    readonly store: Store,
    readonly phone: Telephony,
    config: Partial<AssistantConfig> = {},
    private log: (e: Record<string, unknown>) => void = () => {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    phone.connect({
      answered: (id) => this.onAnswered(id),
      heard: (id, text) => this.onHeard(id, text),
      hungUp: (id) => this.onContactHungUp(id),
      silent: (id) => this.noReply(id),
    });
  }

  start(): void {
    this.ticker ??= setInterval(() => this.tick(), this.config.tickMs);
    this.ticker.unref?.();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    for (const c of this.convs.values()) c.timers.forEach(clearTimeout);
    this.convs.clear();
  }

  get user() {
    return this.store.user.name;
  }

  // ------------------------------------------------------------------ checks

  refusal(contact: Contact, text: string): Refusal | undefined {
    if (EMERGENCY.test(text)) return { reason: "emergency", speech: "I can't help with emergencies. For an emergency, call 911 right away." };
    if (CHILDREN.test(text)) return { reason: "children", speech: "Sorry, to protect children's privacy, CallAssist can't take tasks about kids. Please handle that one yourself." };
    if (!contact.consent)
      return { reason: "no_consent", speech: `${contact.name} hasn't agreed to get calls from CallAssist yet. Add their consent on the CallAssist page first.` };
    if (contact.optedOut) return { reason: "opted_out", speech: `${contact.name} asked not to get calls from CallAssist, so I can't call them.` };
    if (this.store.activeCalls().length >= this.config.maxActiveCalls)
      return { reason: "too_many_calls", speech: `I already have ${this.config.maxActiveCalls} calls going. Try again in a minute.` };
    const cap = this.capHit(contact);
    if (cap) return { reason: "daily_cap", speech: cap };
    return undefined;
  }

  /** Rolling 24-hour call caps, per person and overall. */
  capHit(contact: Contact): string | undefined {
    const since = Date.now() - 24 * 3600_000;
    const recent = [...this.store.calls.values()].filter((c) => new Date(c.createdAt).getTime() > since);
    if (recent.filter((c) => c.contactId === contact.id).length >= this.config.maxCallsPerContactPerDay)
      return `I've already called ${contact.name} ${this.config.maxCallsPerContactPerDay} times today. That's my limit, so they don't get too many calls.`;
    if (recent.length >= this.config.maxCallsPerDay) return `I've made ${this.config.maxCallsPerDay} calls today, which is the daily limit. Try again tomorrow.`;
    return undefined;
  }

  /** Is it a decent hour to call this person? If not, when is the next one? */
  callWindow(contact: Contact, now = new Date()): { open: true } | { open: false; nextOpen: Date; localTime: string } {
    const hours = this.config.callingHours;
    if (!hours) return { open: true };
    const tz = contact.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    const mins = h * 60 + m;
    if (mins >= hours.start && mins < hours.end) return { open: true };
    const wait = mins < hours.start ? hours.start - mins : 24 * 60 - mins + hours.start;
    const localTime = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(now);
    return { open: false, nextOpen: new Date(now.getTime() + wait * 60_000), localTime };
  }

  /** Spoken note for a read-back when the call has to wait for the morning. */
  afterHoursNote(contact: Contact): string | undefined {
    const w = this.callWindow(contact);
    if (w.open) return undefined;
    return `It's ${w.localTime} for ${contact.name}, so I'll call at ${this.startLabel()} their time.`;
  }

  private startLabel(): string {
    const start = this.config.callingHours?.start ?? 0;
    const d = new Date(2000, 0, 1, Math.floor(start / 60), start % 60);
    return formatClock(d);
  }

  findOpenDuplicate(contactId: string, details: string): Task | undefined {
    const d = norm(details);
    return this.store.openTasks().find((t) => t.assigneeId === contactId && norm(t.details) === d);
  }

  // ------------------------------------------------------------------ actions

  /** Create a task and call the person right away. Caller has already checked refusal(). */
  startTask(input: { kind: TaskKind; contact: Contact; title?: string; details: string; question?: string; due?: ParsedTime }): Task {
    const { contact } = input;
    const task = this.store.createTask({
      kind: input.kind,
      title: input.title ?? makeTitle(input.details),
      details: clean(input.details),
      question: input.question ? clean(input.question) : undefined,
      assigneeId: contact.id,
      assigneeName: contact.name,
      dueText: input.due?.text,
      dueAt: input.due?.at?.toISOString(),
    });
    this.store.addUpdate(task.id, "user", input.kind === "message" ? `Message for ${contact.name}: ${task.details}` : `Asked ${contact.name}: ${task.details}`);
    const w = this.callWindow(contact);
    if (!w.open) {
      this.store.updateTask(task.id, { nextActionAt: w.nextOpen.toISOString() });
      this.store.addUpdate(task.id, "system", `It's ${w.localTime} for ${contact.name}. Calling at ${this.startLabel()} their time.`);
      return task;
    }
    this.placeCall(task, "assign");
    return task;
  }

  /** Call the person now to check on an open task. */
  followUp(taskId: string): { ok: true; call: CallRecord } | { ok: false; speech: string } {
    const task = this.store.tasks.get(taskId);
    if (!task) return { ok: false, speech: "I can't find that task." };
    if (CLOSED_TASK.includes(task.status)) return { ok: false, speech: `That task is already ${this.statusWord(task)}.` };
    if (this.activeCallFor(task)) return { ok: false, speech: `I'm already on the phone with ${task.assigneeName} about that.` };
    const contact = this.store.contact(task.assigneeId);
    if (!contact) return { ok: false, speech: "That person isn't in your contacts anymore." };
    const refused = this.refusal(contact, "");
    if (refused) return { ok: false, speech: refused.speech };
    const w = this.callWindow(contact);
    if (!w.open) {
      this.store.updateTask(task.id, { nextActionAt: w.nextOpen.toISOString() });
      return { ok: false, speech: `It's ${w.localTime} for ${contact.name}. I'll check with them at ${this.startLabel()} their time.` };
    }
    const call = this.placeCall(task, task.status === "calling" ? "assign" : "follow_up");
    return { ok: true, call };
  }

  /** Pass the user's answer to the worker's question, by calling them back. */
  answerQuestion(taskId: string, answer: string): { ok: true; call: CallRecord } | { ok: false; speech: string } {
    const task = this.store.tasks.get(taskId);
    if (!task) return { ok: false, speech: "I can't find that task." };
    if (CLOSED_TASK.includes(task.status)) return { ok: false, speech: `That task is already ${this.statusWord(task)}.` };
    const contact = this.store.contact(task.assigneeId);
    if (!contact) return { ok: false, speech: "That person isn't in your contacts anymore." };
    const refused = this.refusal(contact, answer);
    if (refused) return { ok: false, speech: refused.speech };
    const active = this.activeCallFor(task);
    if (active) {
      this.hangUpCall(active.id, "Replaced by a newer call.");
    }
    this.store.addUpdate(task.id, "user", `Answer for ${task.assigneeName}: ${clean(answer)}`);
    const w = this.callWindow(contact);
    if (!w.open) {
      this.store.updateTask(task.id, { status: "calling", nextActionAt: w.nextOpen.toISOString(), pendingAnswer: clean(answer) });
      return { ok: false, speech: `Got it. It's ${w.localTime} for ${contact.name}, so I'll call them with your answer at ${this.startLabel()} their time.` };
    }
    this.store.updateTask(task.id, { status: "calling", nextActionAt: undefined, pendingAnswer: undefined });
    const call = this.placeCall(task, "assign", clean(answer));
    return { ok: true, call };
  }

  /** Cancel a task. Optionally call the person to tell them. */
  cancelTask(taskId: string, notifyPerson: boolean): { ok: true; task: Task; called: boolean } | { ok: false; speech: string } {
    const task = this.store.tasks.get(taskId);
    if (!task) return { ok: false, speech: "I can't find that task." };
    if (CLOSED_TASK.includes(task.status)) return { ok: false, speech: `That task is already ${this.statusWord(task)}.` };
    const active = this.activeCallFor(task);
    if (active) this.hangUpCall(active.id, "Cancelled by the user.");
    const wasStarted = task.status === "accepted" || task.status === "blocked";
    this.store.updateTask(task.id, { status: "cancelled", nextActionAt: undefined });
    this.store.addUpdate(task.id, "user", "Cancelled.");
    let called = false;
    const contact = this.store.contact(task.assigneeId);
    if (notifyPerson && wasStarted && contact && !this.refusal(contact, "") && this.callWindow(contact).open) {
      this.placeCall(task, "cancel_notice");
      called = true;
    }
    return { ok: true, task, called };
  }

  /** The worker phones CallAssist (inbound call). Returns the call id. */
  inboundCall(contactId: string): CallRecord | undefined {
    const contact = this.store.contact(contactId);
    if (!contact) return undefined;
    const open = this.store.openTasks().filter((t) => t.assigneeId === contactId);
    let task = open[0];
    let opening: string[];
    if (task) {
      opening = [`Hi ${firstName(contact.name)}, this is ${this.user}'s AI assistant.`, `Is this about ${task.title}? How's it going?`];
    } else {
      task = this.store.createTask({ kind: "message", title: `${contact.name} called`, details: `${contact.name} called CallAssist`, assigneeId: contact.id, assigneeName: contact.name });
      opening = [`Hi ${firstName(contact.name)}, this is ${this.user}'s AI assistant.`, `What would you like me to pass on to ${this.user}?`];
    }
    const call = this.store.createCall({ taskId: task.id, purpose: "follow_up", contactId: contact.id, contactName: contact.name, phone: contact.phone, script: opening, provider: this.phone.name });
    this.convs.set(call.id, { purpose: "inbound", unclear: 0, askedEta: false, resolved: false, timers: [] });
    this.store.addTranscript(call.id, "system", `${contact.name} called in.`);
    (this.phone as { attachInbound?: (id: string, c: string) => void }).attachInbound?.(call.id, contact.id);
    this.onAnswered(call.id);
    return call;
  }

  /**
   * Record what happened on a call. Used by the local conversation below and by
   * the Amazon Connect AI agent's report tool.
   */
  applyOutcome(callId: string, reading: WorkerReading, opts: { closeCall?: boolean } = {}): Task | undefined {
    const call = this.store.calls.get(callId);
    if (!call) return undefined;
    const task = this.store.tasks.get(call.taskId);
    if (!task) return undefined;
    const conv = this.convs.get(callId);
    const name = task.assigneeName;
    const first = firstName(name);
    // The SIP test number takes no incoming calls, so there is no number to read out there.
    const callbackOk = this.store.contact(task.assigneeId)?.line !== "sip";
    const finish = (line: string) => {
      if (conv) conv.resolved = true;
      this.speak(callId, line);
      if (this.store.business?.callback && callbackOk && reading.intent !== "optout") this.speak(callId, `To reach CallAssist, call ${this.store.business.callback}.`);
      if (opts.closeCall !== false) this.endCall(callId, "Call finished.");
    };

    if (reading.intent === "optout") {
      const contact = this.store.contact(task.assigneeId);
      if (contact) {
        contact.optedOut = true;
        contact.optedOutAt = new Date().toISOString();
        this.log({ event: "opt_out", contactId: contact.id, at: contact.optedOutAt, callId });
      }
      if (!CLOSED_TASK.includes(task.status)) this.store.updateTask(task.id, { status: "declined", reply: reading.text, nextActionAt: undefined });
      this.store.addUpdate(task.id, "worker", reading.text);
      this.tell(task, `${name} asked not to get calls from CallAssist. I won't call them again.`);
      finish(`Understood. I won't call you again. Sorry to bother you, take care.`);
      return task;
    }

    if (call.purpose === "cancel_notice" || task.status === "cancelled") {
      this.store.addUpdate(task.id, "worker", reading.text);
      finish(`Thanks, ${first}. Bye for now!`);
      return task;
    }

    if (task.kind === "message" && conv?.purpose !== "inbound") {
      this.store.updateTask(task.id, { status: "done", reply: reading.text, nextActionAt: undefined });
      this.store.addUpdate(task.id, "worker", reading.text);
      this.tell(task, `${name} says: "${reading.text}"`);
      finish(`Got it, I'll pass that on to ${this.user}. Thanks, ${first}!`);
      return task;
    }

    if (conv?.purpose === "inbound" && task.kind === "message") {
      this.store.updateTask(task.id, { status: "done", reply: reading.text });
      this.store.addUpdate(task.id, "worker", reading.text);
      this.tell(task, `${name} called and said: "${reading.text}"`);
      finish(`Okay, I'll let ${this.user} know. Thanks, ${first}!`);
      return task;
    }

    switch (reading.intent) {
      case "done": {
        this.store.updateTask(task.id, { status: "done", reply: reading.text, nextActionAt: undefined });
        this.store.addUpdate(task.id, "worker", reading.text);
        this.tell(task, `${name} says it's done: ${task.title}.`);
        finish(`Oh great, thank you! I'll let ${this.user} know it's done.`);
        return task;
      }
      case "accept":
      case "eta_only": {
        const eta = reading.eta ?? (task.dueText ? { text: task.dueText, at: task.dueAt ? new Date(task.dueAt) : undefined } : undefined);
        if (!eta && conv && !conv.askedEta && task.kind === "task") {
          conv.askedEta = true;
          this.store.updateTask(task.id, { status: "accepted", reply: reading.text });
          this.store.addUpdate(task.id, "worker", reading.text);
          this.speak(callId, "Great, thanks! Roughly when do you think it'll be done?");
          return task;
        }
        const etaAt = eta?.at?.toISOString();
        const followAt = etaAt ? new Date(new Date(etaAt).getTime() + this.config.followUpGraceMs).toISOString() : undefined;
        this.store.updateTask(task.id, { status: "accepted", eta: eta?.text, etaAt, reply: reading.text, nextActionAt: followAt });
        this.store.addUpdate(task.id, "worker", reading.text);
        this.tell(task, eta ? `${name} is on it: ${task.title}, ${eta.text}.` : `${name} is on it: ${task.title}.`);
        finish(eta ? `Perfect, ${eta.text} then. Thanks so much, ${first}!` : `Perfect. Thanks so much, ${first}!`);
        return task;
      }
      case "decline": {
        this.store.updateTask(task.id, { status: "declined", reply: reading.text, nextActionAt: undefined });
        this.store.addUpdate(task.id, "worker", reading.text);
        this.tell(task, `${name} can't do it: "${reading.text}". Want me to ask someone else?`);
        finish(`No problem at all. I'll let ${this.user} know. Thanks, ${first}!`);
        return task;
      }
      case "blocked": {
        this.store.updateTask(task.id, { status: "blocked", reply: reading.text, nextActionAt: undefined });
        this.store.addUpdate(task.id, "worker", reading.text);
        this.tell(task, `${name} has a problem with ${task.title}: "${reading.text}". What should I tell them?`);
        finish(`Okay, I'll check with ${this.user} and get back to you.`);
        return task;
      }
      case "question": {
        this.store.updateTask(task.id, { status: "blocked", reply: reading.text, nextActionAt: undefined });
        this.store.addUpdate(task.id, "worker", reading.text);
        this.tell(task, `${name} asks about ${task.title}: "${reading.text}". What should I tell them?`);
        finish(`Good question. Let me check with ${this.user}, and I'll call you right back.`);
        return task;
      }
      default: {
        if (conv?.askedEta && task.status === "accepted") {
          this.store.addUpdate(task.id, "worker", reading.text);
          this.tell(task, `${name} is on it: ${task.title}.`);
          finish(`No problem. Thanks, ${first}!`);
          return task;
        }
        if (conv && conv.unclear < 1) {
          conv.unclear++;
          this.speak(callId, call.purpose === "follow_up" ? "Sorry, I didn't catch that. Is it done yet?" : "Sorry, I didn't catch that. Would you be able to do it?");
          return task;
        }
        this.store.addUpdate(task.id, "worker", reading.text);
        this.speak(callId, "Sorry, the line's not very clear. I'll try you again later. Bye for now!");
        if (conv) conv.resolved = true;
        this.endCall(callId, "Couldn't understand the answer.");
        this.afterFailedCall(task, call, "I couldn't understand the answer");
        return task;
      }
    }
  }

  // ------------------------------------------------------------------ calls

  private placeCall(task: Task, purpose: CallPurpose, answer?: string): CallRecord {
    const contact = this.store.contact(task.assigneeId)!;
    const script = this.script(task, purpose, answer);
    const call = this.store.createCall({ taskId: task.id, purpose, contactId: contact.id, contactName: contact.name, phone: contact.phone, script, provider: this.phone.name });
    if (purpose === "assign") this.store.updateTask(task.id, { attempts: task.attempts + 1, nextActionAt: undefined });
    if (purpose === "follow_up") this.store.updateTask(task.id, { followUps: task.followUps + 1, nextActionAt: undefined });
    const conv: Conversation = { purpose, unclear: 0, askedEta: false, resolved: false, answer, timers: [] };
    this.convs.set(call.id, conv);
    this.store.addTranscript(call.id, "system", `Calling ${contact.name}…`);
    this.log({ event: "call_ring", callId: call.id, taskId: task.id, purpose, contact: contact.name });
    this.timer(call.id, this.config.ringTimeoutMs, () => {
      const c = this.store.calls.get(call.id);
      if (c?.status === "ringing") this.onNoAnswer(call.id);
    });
    try {
      this.phone.ring(call);
    } catch (err) {
      this.store.updateCall(call.id, { status: "failed" });
      this.log({ event: "call_failed", callId: call.id, error: String(err) });
      this.afterFailedCall(task, call, "the call didn't go through");
    }
    return call;
  }

  private script(task: Task, purpose: CallPurpose, answer?: string): string[] {
    const biz = this.store.business ? ` at ${this.store.business.name}` : "";
    const first = firstName(task.assigneeName);
    const hi = `Hi ${first}! This is ${this.user}'s AI assistant${biz}. Just a quick one, and you can say stop anytime.`;
    if (purpose === "cancel_notice") return [hi, `${this.user} has cancelled ${task.title}, so there's no need to do it anymore. Sorry for the trouble!`];
    if (purpose === "follow_up") return [`Hi ${first}, it's ${this.user}'s AI assistant again.`, `Just checking in on ${task.title}. Is it done yet?`];
    if (answer) {
      const q = task.reply ? `You'd asked: "${task.reply}". ` : "";
      return [hi, `About ${task.title}. ${q}${this.user} says: ${answer}.`, "Can you go ahead?"];
    }
    if (task.kind === "message") return [hi, `${this.user} asked me to tell you: ${task.details}.`, task.question ?? `Anything you'd like me to tell ${this.user}?`];
    if (task.kind === "errand") return [hi, task.details, task.question ?? "Would you be able to do that?"];
    const due = task.dueText ? ` ${this.user} needs it ${task.dueText}.` : "";
    return [hi, `${this.user} was wondering if you could ${asAsk(task.details)}.${due}`, "Would you be able to do that?"];
  }

  private onAnswered(callId: string): void {
    const call = this.store.calls.get(callId);
    if (!call || (call.status !== "ringing" && call.status !== "in_progress")) return;
    this.store.updateCall(callId, { status: "in_progress" });
    this.clearTimers(callId);
    for (const line of call.script) this.speak(callId, line);
    if (call.purpose === "cancel_notice") {
      // Nothing to ask: say it and hang up.
      this.speak(callId, "Thank you. Bye for now!");
      this.endCall(callId, "Told them it's cancelled.");
      return;
    }
    this.armSilence(callId);
  }

  private onHeard(callId: string, raw: string): void {
    const call = this.store.calls.get(callId);
    const text = clean(raw).slice(0, 500);
    if (!call || call.status !== "in_progress" || !text) return;
    const conv = this.convs.get(callId);
    if (conv?.resolved) return;
    this.store.addTranscript(callId, "contact", text);
    this.armSilence(callId);
    this.applyOutcome(callId, readWorker(text));
  }

  private onContactHungUp(callId: string): void {
    const call = this.store.calls.get(callId);
    if (!call || FINAL_CALL.includes(call.status)) return;
    const conv = this.convs.get(callId);
    const wasRinging = call.status === "ringing";
    this.clearTimers(callId);
    this.store.updateCall(callId, { status: wasRinging ? "rejected" : "ended" });
    this.store.addTranscript(callId, "system", wasRinging ? `${call.contactName} rejected the call.` : `${call.contactName} hung up.`);
    this.convs.delete(callId);
    const task = this.store.tasks.get(call.taskId);
    if (task && !conv?.resolved && call.purpose !== "cancel_notice" && !CLOSED_TASK.includes(task.status) && task.status !== "blocked") {
      this.afterFailedCall(task, call, wasRinging ? "they rejected the call" : "they hung up before answering");
    }
  }

  private onNoAnswer(callId: string): void {
    const call = this.store.calls.get(callId);
    if (!call) return;
    this.clearTimers(callId);
    this.store.updateCall(callId, { status: "no_answer" });
    this.store.addTranscript(callId, "system", "No answer.");
    this.phone.hangUp(callId, "no_answer");
    this.convs.delete(callId);
    const task = this.store.tasks.get(call.taskId);
    if (task && call.purpose !== "cancel_notice" && !CLOSED_TASK.includes(task.status)) this.afterFailedCall(task, call, "no answer");
  }

  /** Decide what to do after a call that got no usable answer. */
  private afterFailedCall(task: Task, call: CallRecord, why: string): void {
    const fresh = this.store.tasks.get(task.id)!;
    if (call.purpose === "follow_up") {
      if (fresh.followUps < this.config.maxFollowUps) {
        const at = new Date(Date.now() + this.config.retryDelayMs);
        this.store.updateTask(fresh.id, { nextActionAt: at.toISOString() });
        this.store.addUpdate(fresh.id, "system", `Follow-up failed (${why}). Trying again at ${formatClock(at)}.`);
      } else {
        this.store.updateTask(fresh.id, { nextActionAt: undefined });
        this.tell(fresh, `I couldn't reach ${fresh.assigneeName} for an update on ${fresh.title}. Last I heard: ${fresh.eta ? `they'd finish ${fresh.eta}` : "they were on it"}.`);
      }
      return;
    }
    if (fresh.attempts < this.config.maxAttempts) {
      const at = new Date(Date.now() + this.config.retryDelayMs);
      this.store.updateTask(fresh.id, { status: "calling", nextActionAt: at.toISOString() });
      this.store.addUpdate(fresh.id, "system", `Couldn't reach ${fresh.assigneeName} (${why}). Trying again at ${formatClock(at)}.`);
    } else {
      this.store.updateTask(fresh.id, { status: "unreachable", nextActionAt: undefined });
      this.tell(fresh, `I couldn't reach ${fresh.assigneeName} after ${fresh.attempts} tries about ${fresh.title}. Want me to try someone else?`);
    }
  }

  private speak(callId: string, text: string): void {
    this.store.addTranscript(callId, "assistant", text);
    this.phone.speak(callId, text);
  }

  private endCall(callId: string, note: string): void {
    const call = this.store.calls.get(callId);
    if (!call || FINAL_CALL.includes(call.status)) return;
    this.clearTimers(callId);
    this.store.updateCall(callId, { status: "ended" });
    this.store.addTranscript(callId, "system", note);
    this.phone.hangUp(callId, "ended");
    this.convs.delete(callId);
  }

  private hangUpCall(callId: string, note: string): void {
    const call = this.store.calls.get(callId);
    if (!call || FINAL_CALL.includes(call.status)) return;
    this.clearTimers(callId);
    this.store.updateCall(callId, { status: "cancelled" });
    this.store.addTranscript(callId, "system", note);
    this.phone.hangUp(callId, "cancelled");
    this.convs.delete(callId);
  }

  private armSilence(callId: string): void {
    this.clearTimers(callId);
    this.timer(callId, this.config.silenceTimeoutMs, () => this.noReply(callId));
  }

  /** Nobody is answering on an open line: end politely, keep any yes already given, retry otherwise. */
  private noReply(callId: string): void {
    const call = this.store.calls.get(callId);
    if (call?.status !== "in_progress") return;
    this.speak(callId, "Sorry, I can't hear you very well. I'll try you again later. Bye for now!");
    const conv = this.convs.get(callId);
    const resolved = conv?.resolved;
    this.endCall(callId, "No reply on the line.");
    const task = this.store.tasks.get(call.taskId);
    if (task && !resolved && call.purpose !== "cancel_notice" && !CLOSED_TASK.includes(task.status)) {
      if (task.status === "accepted" && call.purpose === "assign") return; // they already said yes
      this.afterFailedCall(task, call, "no reply on the line");
    }
  }

  activeCallFor(task: Task): CallRecord | undefined {
    return task.callIds.map((id) => this.store.calls.get(id)).find((c) => c && !FINAL_CALL.includes(c.status));
  }

  // ------------------------------------------------------------------ scheduler

  /** Retries and follow-ups that are due. Runs every tickMs. */
  private lastSweep = 0;

  tick(now = Date.now()): void {
    if (now - this.lastSweep > 3600_000) {
      this.lastSweep = now;
      this.sweepRetention(now);
    }
    for (const task of this.store.sortedTasks()) {
      if (!task.nextActionAt || new Date(task.nextActionAt).getTime() > now) continue;
      if (CLOSED_TASK.includes(task.status) || this.activeCallFor(task)) continue;
      const contact = this.store.contact(task.assigneeId);
      if (!contact || contact.optedOut) {
        this.store.updateTask(task.id, { nextActionAt: undefined });
        continue;
      }
      if (this.store.activeCalls().length >= this.config.maxActiveCalls) return;
      if (this.capHit(contact)) {
        this.store.updateTask(task.id, { nextActionAt: new Date(now + 3600_000).toISOString() });
        continue;
      }
      const w = this.callWindow(contact, new Date(now));
      if (!w.open) {
        this.store.updateTask(task.id, { nextActionAt: w.nextOpen.toISOString() });
        continue;
      }
      if (task.status === "calling") {
        const answer = task.pendingAnswer;
        if (answer) this.store.updateTask(task.id, { pendingAnswer: undefined });
        this.placeCall(task, "assign", answer);
      }
      else if (task.status === "accepted") {
        if (task.followUps >= this.config.maxFollowUps) {
          this.store.updateTask(task.id, { nextActionAt: undefined });
          continue;
        }
        this.placeCall(task, "follow_up");
      } else this.store.updateTask(task.id, { nextActionAt: undefined });
    }
  }

  // ------------------------------------------------------------------ reporting

  statusWord(task: Task): string {
    return { calling: "being called", unreachable: "unreachable", accepted: "in progress", declined: "declined", blocked: "waiting on you", done: "done", cancelled: "cancelled" }[task.status];
  }

  /** One spoken sentence about where a task stands. */
  statusSpeech(task: Task): string {
    const n = task.assigneeName;
    const active = this.activeCallFor(task);
    switch (task.status) {
      case "calling":
        if (active?.status === "in_progress") return `I'm on the phone with ${n} right now about ${task.title}.`;
        if (active) return `Calling ${n} about ${task.title} now.`;
        if (task.nextActionAt && task.attempts === 0) return `I'll call ${n} about ${task.title} at ${formatClock(new Date(task.nextActionAt))}, when it's not too late for them.`;
        return task.nextActionAt
          ? `${n} didn't pick up yet. I'll try again at ${formatClock(new Date(task.nextActionAt))}.`
          : `I'm trying to reach ${n} about ${task.title}.`;
      case "accepted":
        if (active) return `${n} is on it, and I'm checking with them now.`;
        return task.eta ? `${n} is on it: ${task.title}, ${task.eta}.` : `${n} is on it: ${task.title}.`;
      case "done":
        return task.kind === "message" ? `${n} says: "${task.reply}".` : `Done. ${n} finished: ${task.title}.`;
      case "declined":
        return `${n} can't do ${task.title}. They said: "${task.reply}".`;
      case "blocked":
        return `${n} needs your input on ${task.title}. They said: "${task.reply}".`;
      case "unreachable":
        return `I couldn't reach ${n} about ${task.title}.`;
      case "cancelled":
        return `${task.title} was cancelled.`;
    }
  }

  private tell(task: Task, text: string): void {
    this.store.notify(task.id, text);
    this.store.addUpdate(task.id, "assistant", text);
    this.log({ event: "notify", taskId: task.id, status: task.status, chars: text.length });
    try {
      this.config.mailer?.send(renderEmail(this.store.tasks.get(task.id) ?? task, text, this.store.user, this.store.business));
    } catch (err) {
      this.log({ event: "email_failed", taskId: task.id, error: String(err) });
    }
  }

  /** Deletes closed tasks (with their calls and notifications) older than retentionDays. */
  sweepRetention(now = Date.now()): number {
    const cutoff = now - this.config.retentionDays * 24 * 3600_000;
    let removed = 0;
    for (const t of [...this.store.tasks.values()]) {
      if (!CLOSED_TASK.includes(t.status) || new Date(t.updatedAt).getTime() > cutoff) continue;
      for (const id of t.callIds) this.store.calls.delete(id);
      this.store.notifications = this.store.notifications.filter((n) => n.taskId !== t.id);
      this.store.tasks.delete(t.id);
      removed++;
    }
    if (removed) {
      this.store.touch();
      this.log({ event: "retention_sweep", removed });
    }
    return removed;
  }


  private timer(callId: string, ms: number, fn: () => void): void {
    const conv = this.convs.get(callId);
    const t = setTimeout(fn, ms);
    t.unref?.();
    if (conv) conv.timers.push(t);
  }

  private clearTimers(callId: string): void {
    const conv = this.convs.get(callId);
    if (!conv) return;
    conv.timers.forEach(clearTimeout);
    conv.timers = [];
  }
}

/** "Ravi Kumar" → "Ravi": people are greeted by first name. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "Set up the room." → "set up the room", ready for "could you …". A noun phrase gets "help with". */
function asAsk(details: string): string {
  const d = details.trim().replace(/[.!]+$/, "");
  const firstWord = d.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (/^(the|a|an|my|our|your|his|her|their|this|that|some)$/.test(firstWord)) return `help with ${d.charAt(0).toLowerCase()}${d.slice(1)}`;
  return d.charAt(0).toLowerCase() + d.slice(1);
}
