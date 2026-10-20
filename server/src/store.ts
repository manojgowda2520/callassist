// Local data store: the user's team (trusted contacts), predefined errands,
// tasks and the phone calls made for them. In memory, optionally saved to a
// JSON file. On AWS this becomes DynamoDB behind the same methods.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export interface User {
  name: string;
  email: string;
  timezone?: string;
}

export interface Contact {
  id: string;
  name: string;
  label: string;
  aliases: string[];
  phone: string;
  consent: boolean;
  optedOut: boolean;
  /** IANA time zone, e.g. "America/New_York". Defaults to the server's zone. */
  timezone?: string;
  /** Proof of prior express consent (TCPA): when, how, and the exact words agreed to. */
  consentRecord?: { at: string; method: string; wording: string };
  /** When they asked not to be called again. */
  optedOutAt?: string;
}

/** The business responsible for the calls (47 CFR 64.1200(b)). */
export interface Business {
  name: string;
  callback: string;
}

export interface Errand {
  id: string;
  name: string;
  triggers: string[];
  place: string;
  contactId: string;
  message: string;
  question?: string;
}

/** What a task is for: a free-form job, a predefined errand, or a message with an optional question. */
export type TaskKind = "task" | "errand" | "message";

export type TaskStatus =
  | "calling" // CallAssist is trying to reach the person
  | "unreachable" // no answer after every attempt
  | "accepted" // the person said they'll do it
  | "declined" // the person can't do it
  | "blocked" // the person hit a problem and needs the user
  | "done" // finished (for messages: the reply came back)
  | "cancelled";

export const OPEN_TASK: TaskStatus[] = ["calling", "accepted", "blocked"];
export const CLOSED_TASK: TaskStatus[] = ["unreachable", "declined", "done", "cancelled"];

export type CallPurpose = "assign" | "follow_up" | "cancel_notice";
export type CallStatus = "ringing" | "in_progress" | "ended" | "no_answer" | "rejected" | "cancelled" | "failed";
export const FINAL_CALL: CallStatus[] = ["ended", "no_answer", "rejected", "cancelled", "failed"];

export interface TaskUpdate {
  at: string;
  from: "user" | "assistant" | "worker" | "system";
  text: string;
}

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  details: string;
  question?: string;
  assigneeId: string;
  assigneeName: string;
  dueText?: string;
  dueAt?: string;
  status: TaskStatus;
  eta?: string;
  etaAt?: string;
  reply?: string;
  attempts: number;
  followUps: number;
  nextActionAt?: string;
  /** The user's answer to the worker's question, waiting for calling hours. */
  pendingAnswer?: string;
  updates: TaskUpdate[];
  callIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CallRecord {
  id: string;
  taskId: string;
  purpose: CallPurpose;
  contactId: string;
  contactName: string;
  phone: string;
  status: CallStatus;
  script: string[];
  transcript: { who: "assistant" | "contact" | "system"; text: string; at: string }[];
  provider: string;
  providerRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  at: string;
  taskId: string;
  text: string;
  read: boolean;
}

export interface SeedData {
  user: User;
  business?: Business;
  contacts: Contact[];
  errands: Errand[];
  defaultPlace: string;
}

export type StoreEvent =
  | { type: "task"; task: Task }
  | { type: "call"; call: CallRecord }
  | { type: "notification"; notification: Notification };

export class Store {
  user: User;
  business?: Business;
  contacts: Contact[];
  errands: Errand[];
  defaultPlace: string;
  tasks = new Map<string, Task>();
  calls = new Map<string, CallRecord>();
  notifications: Notification[] = [];
  private listeners = new Set<(e: StoreEvent) => void>();

  constructor(seed: SeedData, private file?: string) {
    const copy: SeedData = structuredClone(seed);
    this.user = copy.user;
    this.business = copy.business;
    this.contacts = copy.contacts;
    this.errands = copy.errands;
    this.defaultPlace = copy.defaultPlace;
    if (file && existsSync(file)) this.load(file);
  }

  static fromFile(seedPath: string, dataFile?: string): Store {
    return new Store(JSON.parse(readFileSync(seedPath, "utf8")), dataFile);
  }

  subscribe(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  contact(id: string): Contact | undefined {
    return this.contacts.find((c) => c.id === id);
  }

  // ---- tasks ----

  createTask(input: Pick<Task, "kind" | "title" | "details" | "question" | "assigneeId" | "assigneeName" | "dueText" | "dueAt">): Task {
    const now = new Date().toISOString();
    const task: Task = { ...input, id: randomUUID(), status: "calling", attempts: 0, followUps: 0, updates: [], callIds: [], createdAt: now, updatedAt: now };
    this.tasks.set(task.id, task);
    this.emit({ type: "task", task });
    return task;
  }

  updateTask(id: string, patch: Partial<Task>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.emit({ type: "task", task });
    return task;
  }

  addUpdate(id: string, from: TaskUpdate["from"], text: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.updates.push({ at: new Date().toISOString(), from, text });
    task.updatedAt = new Date().toISOString();
    this.emit({ type: "task", task });
  }

  openTasks(): Task[] {
    return this.sortedTasks().filter((t) => OPEN_TASK.includes(t.status));
  }

  sortedTasks(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ---- calls ----

  createCall(input: Pick<CallRecord, "taskId" | "purpose" | "contactId" | "contactName" | "phone" | "script" | "provider">): CallRecord {
    const now = new Date().toISOString();
    const call: CallRecord = { ...input, id: randomUUID(), status: "ringing", transcript: [], createdAt: now, updatedAt: now };
    this.calls.set(call.id, call);
    const task = this.tasks.get(input.taskId);
    if (task) task.callIds.push(call.id);
    this.emit({ type: "call", call });
    return call;
  }

  updateCall(id: string, patch: Partial<CallRecord>): CallRecord | undefined {
    const call = this.calls.get(id);
    if (!call) return undefined;
    Object.assign(call, patch, { updatedAt: new Date().toISOString() });
    this.emit({ type: "call", call });
    return call;
  }

  addTranscript(id: string, who: CallRecord["transcript"][number]["who"], text: string): void {
    const call = this.calls.get(id);
    if (!call) return;
    call.transcript.push({ who, text, at: new Date().toISOString() });
    call.updatedAt = new Date().toISOString();
    this.emit({ type: "call", call });
  }

  activeCalls(): CallRecord[] {
    return [...this.calls.values()].filter((c) => !FINAL_CALL.includes(c.status));
  }

  // ---- notifications (Alexa+ style updates to the user) ----

  notify(taskId: string, text: string): Notification {
    const n: Notification = { id: randomUUID(), at: new Date().toISOString(), taskId, text, read: false };
    this.notifications.push(n);
    if (this.notifications.length > 200) this.notifications.shift();
    this.emit({ type: "notification", notification: n });
    return n;
  }

  /** Save after a bulk change that emitted no events (e.g. retention deletes). */
  touch(): void {
    this.save();
  }

  // ---- persistence ----

  private emit(e: StoreEvent): void {
    this.save();
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a broken listener must never break the store
      }
    }
  }

  private load(file: string): void {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      for (const t of saved.tasks ?? []) this.tasks.set(t.id, t);
      for (const c of saved.calls ?? []) this.calls.set(c.id, c);
      this.notifications = saved.notifications ?? [];
      for (const entry of saved.optedOut ?? []) {
        const id = typeof entry === "string" ? entry : entry.id;
        const contact = this.contact(id);
        if (contact) {
          contact.optedOut = true;
          if (typeof entry === "object") contact.optedOutAt = entry.at;
        }
      }
    } catch {
      // a corrupt data file is ignored; the seed still loads
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const optedOut = this.contacts.filter((c) => c.optedOut).map((c) => ({ id: c.id, at: c.optedOutAt }));
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tasks: [...this.tasks.values()], calls: [...this.calls.values()], notifications: this.notifications, optedOut }, null, 2));
    renameSync(tmp, this.file);
  }
}
