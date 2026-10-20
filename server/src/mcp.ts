// The CallAssist MCP server: the tools Alexa+ (or the local emulator) calls.
// Design rules: docs/alexa-plus-design-rules.md
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CHILDREN, EMERGENCY, type Assistant } from "./assistant.js";
import { CLOSED_TASK, OPEN_TASK, type Contact, type Errand, type Store, type Task } from "./store.js";
import { parseTime } from "./time.js";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

export function findContacts(store: Store, query: string): Contact[] {
  const q = norm(query).replace(/^(my|the|our)\s+/, "");
  if (!q) return [];
  const exact = store.contacts.filter((c) => norm(c.name) === q);
  if (exact.length) return exact;
  return store.contacts.filter(
    (c) => norm(c.name).split(" ").includes(q) || c.aliases.some((a) => norm(a) === q) || norm(c.label) === q || norm(c.label).split(" ").includes(q),
  );
}

export function matchErrand(store: Store, request: string, place?: string): Errand[] {
  const text = ` ${norm(request)} `;
  const hits = store.errands.filter((e) => e.triggers.some((t) => text.includes(` ${norm(t)} `)));
  const where = place ? norm(place) : undefined;
  if (where) return hits.filter((e) => norm(e.place) === where);
  const preferred = hits.filter((e) => e.place === store.defaultPlace);
  return preferred.length ? preferred : hits;
}

function say(text: string, data: Record<string, unknown> = {}, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: { speech: text, ...data }, ...(isError ? { isError: true } : {}) };
}

const STATUS = z.enum(["calling", "unreachable", "accepted", "declined", "blocked", "done", "cancelled"]);
const TaskOut = z.looseObject({
  taskId: z.string(),
  kind: z.enum(["task", "errand", "message"]),
  title: z.string(),
  person: z.string(),
  status: STATUS,
  statusText: z.string(),
  due: z.string().optional(),
  eta: z.string().optional(),
  reply: z.string().optional(),
  onCall: z.string().optional(),
  nextTryAt: z.string().optional(),
  updates: z.array(z.looseObject({ from: z.string(), text: z.string(), at: z.string() })),
  createdAt: z.string(),
});

/** One output shape for every tool: what to say, plus data for cards. */
export const OUTPUT = z.looseObject({
  speech: z.string().describe("What to say to the user. Same text as the content block; never contains IDs or codes."),
  reason: z.string().optional().describe("Why something couldn't be done, e.g. not_found, ambiguous, no_consent, opted_out, emergency, children, daily_cap, confirmation_missing"),
  needsConfirmation: z.boolean().optional().describe("True on a read-back: ask the user, then call again with confirmed=true and confirmationToken"),
  confirmationToken: z.string().optional().describe("One-time token for the read-back just given; send it back with confirmed=true"),
  duplicate: z.boolean().optional(),
  afterHours: z.string().optional().describe("Set when the call must wait for the person's calling hours"),
  taskId: z.string().optional(),
  kind: z.enum(["task", "errand", "message"]).optional(),
  title: z.string().optional(),
  person: z.string().optional(),
  personRole: z.string().optional(),
  status: STATUS.optional(),
  statusText: z.string().optional(),
  due: z.string().optional(),
  eta: z.string().optional(),
  reply: z.string().optional(),
  message: z.string().optional(),
  question: z.string().optional(),
  tasks: z.array(TaskOut).optional(),
  total: z.number().optional(),
  user: z.string().optional(),
  contacts: z.array(z.looseObject({ name: z.string(), role: z.string() })).optional(),
  errands: z.array(z.looseObject({ name: z.string(), place: z.string() })).optional(),
});

export function taskView(a: Assistant, t: Task) {
  const active = a.activeCallFor(t);
  return {
    taskId: t.id,
    kind: t.kind,
    title: t.title,
    details: t.details,
    person: t.assigneeName,
    status: t.status,
    statusText: a.statusWord(t),
    due: t.dueText,
    eta: t.eta,
    reply: t.reply,
    onCall: active ? active.status : undefined,
    nextTryAt: t.nextActionAt,
    updates: t.updates.slice(-8).map(({ from, text, at }) => ({ from, text, at })),
    createdAt: t.createdAt,
  };
}

/** Resolve one person, or return the spoken error. */
function onePerson(store: Store, name: string): { contact: Contact } | { error: CallToolResult } {
  const found = findContacts(store, name);
  if (!found.length) return { error: say(`I couldn't find ${clean(name)} in your team.`, { reason: "not_found" }, true) };
  if (found.length > 1)
    return {
      error: say(`Which ${clean(name)}? ${found.slice(0, 5).map((c) => `${c.name}, ${c.label}`).join("; ")}.`, {
        reason: "ambiguous",
        contacts: found.map((c) => ({ name: c.name, label: c.label })),
      }, true),
    };
  return { contact: found[0] };
}

/** Find the task the user means: by id, by person, or the most recent one. */
function pickTask(store: Store, taskId?: string, person?: string, openOnly = false): { task: Task } | { error: CallToolResult } {
  if (taskId) {
    const t = store.tasks.get(taskId);
    return t ? { task: t } : { error: say("I can't find that task.", { reason: "not_found" }, true) };
  }
  let pool = store.sortedTasks().filter((t) => t.title !== `${t.assigneeName} called`);
  if (person) {
    const p = onePerson(store, person);
    if ("error" in p) return p;
    pool = pool.filter((t) => t.assigneeId === p.contact.id);
    if (!pool.length) return { error: say(`You haven't given ${p.contact.name} any tasks yet.`, { reason: "not_found" }, true) };
  }
  const open = pool.filter((t) => OPEN_TASK.includes(t.status));
  const t = openOnly ? open[0] : open[0] ?? pool[0];
  if (!t) return { error: say(openOnly ? "There's nothing open right now." : "You haven't given anyone a task yet.", { reason: "not_found" }, true) };
  return { task: t };
}

async function waitForChange(a: Assistant, taskId: string, seconds: number): Promise<Task | undefined> {
  const start = a.store.tasks.get(taskId);
  if (!start || seconds <= 0) return start;
  const settled = (t: Task) => t.status !== "calling" && !a.activeCallFor(t);
  if (settled(start)) return start;
  return new Promise((resolve) => {
    const done = () => {
      off();
      clearTimeout(timer);
      resolve(a.store.tasks.get(taskId));
    };
    const off = a.store.subscribe((e) => {
      if (e.type === "task" && e.task.id === taskId && settled(e.task)) done();
      if (e.type === "call" && e.call.taskId === taskId) {
        const t = a.store.tasks.get(taskId);
        if (t && settled(t)) done();
      }
    });
    const timer = setTimeout(done, seconds * 1000);
  });
}

export function createMcpServer(a: Assistant, log: (e: Record<string, unknown>) => void = () => {}): McpServer {
  const store = a.store;
  const server = new McpServer(
    { name: "callassist", title: "CallAssist", version: "0.2.0" },
    {
      instructions:
        "CallAssist is the user's personal assistant on the phone. It hands tasks to the user's people (staff, family, helpers) by calling them, follows up, and reports back. Tools: assign_task (give someone a job), run_errand (preset errands like coffee), deliver_message (message plus one question), get_task_status (one task), list_tasks (several), follow_up (call now for an update), answer_question (reply to a worker's question), cancel_task, list_team, list_errands. IMPORTANT: assign_task, run_errand, deliver_message and cancel_task first return a read-back with a confirmationToken. Speak the read-back, wait for an explicit yes, then call again with confirmed=true and that exact token. Never invent a yes.",
    },
  );

  const wrap =
    <A,>(name: string, fn: (args: A) => Promise<CallToolResult> | CallToolResult) =>
    async (args: A): Promise<CallToolResult> => {
      const started = Date.now();
      try {
        // Hard cap so Alexa+ is never left waiting (get_task_status may wait up to 25 s by request).
        const limitMs = name === "get_task_status" ? 28_000 : 10_000;
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          Promise.resolve(fn(args)),
          new Promise<CallToolResult>((resolve) => {
            timer = setTimeout(() => resolve(say("That's taking longer than it should. Please ask me again in a moment.", { reason: "timeout" }, true)), limitMs);
          }),
        ]).finally(() => clearTimeout(timer));
        log({ event: "tool", tool: name, args: redact(args), isError: !!result.isError, reason: (result.structuredContent as { reason?: string } | undefined)?.reason, ms: Date.now() - started });
        return result;
      } catch (err) {
        log({ event: "tool_error", tool: name, args: redact(args), error: String(err) });
        return say("Something went wrong on my side. Please try again.", { reason: "internal" }, true);
      }
    };

  /**
   * The read-back → yes → act gate. The read-back hands out a one-time token
   * bound to exactly what was read back; the action needs it back unchanged.
   */
  const gate = (
    tool: string,
    fingerprint: string,
    confirmed: boolean | undefined,
    token: string | undefined,
    readback: () => { speech: string; data: Record<string, unknown> },
    act: () => { task: Task; speech: string },
  ): CallToolResult => {
    const offer = (prefix = "", reason?: string) => {
      const r = readback();
      return say(`${prefix}${r.speech}`, { needsConfirmation: true, confirmationToken: a.confirmations.issue(tool, fingerprint), ...(reason ? { reason } : {}), ...r.data });
    };
    if (!confirmed) return offer();
    const c = a.confirmations.check(tool, fingerprint, token);
    if (c.ok === "replay") {
      const t = store.tasks.get(c.taskId);
      return t ? say(`Already done. ${a.statusSpeech(t)}`, { duplicate: true, ...taskView(a, t) }) : offer();
    }
    if (!c.ok) {
      log({ event: "confirmation_rejected", tool, reason: c.reason });
      return offer("Before I do that, I need your okay. ", `confirmation_${c.reason}`);
    }
    const { task, speech } = act();
    a.confirmations.complete(token!, task.id);
    return say(speech, taskView(a, task));
  };

  // ------------------------------------------------------------- assign_task
  server.registerTool(
    "assign_task",
    {
      title: "Give someone a task",
      description:
        "Hands a task to one of the user's people by phone: CallAssist calls them, explains what the user needs, gets a yes and a time, follows up later, and reports back. Synonyms: ask, tell, have, get, assign, delegate, make sure. Call first without confirmed to get a read-back; call again with confirmed=true and the confirmationToken only after the user says yes.",
      inputSchema: {
        person: z.string().min(1).max(60).describe("Who should do it: name, nickname or role (e.g. 'Raju', 'the driver', 'accounts')"),
        task: z.string().min(3).max(400).describe("What needs to be done, in the user's words"),
        due: z.string().max(60).optional().describe("When it's needed, e.g. 'by 3 pm', 'in 20 minutes', 'today'"),
        confirmed: z.boolean().optional().describe("Set true only after the user explicitly said yes to the read-back. Always send confirmationToken with it"),
        confirmationToken: z.string().max(64).optional().describe("IMPORTANT: required with confirmed=true. Copy it exactly from the read-back result; it proves the user heard that read-back and said yes"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
      outputSchema: OUTPUT,
    },
    wrap("assign_task", ({ person, task, due, confirmed, confirmationToken }: { person: string; task: string; due?: string; confirmed?: boolean; confirmationToken?: string }) => {
      const p = onePerson(store, person);
      if ("error" in p) return p.error;
      const details = clean(task).replace(/[.!]+$/, "");
      if (!details) return say("What should they do?", { reason: "empty_task" }, true);
      const when = parseTime(due ?? "") ?? parseTime(details);
      const refused = a.refusal(p.contact, `${details} ${due ?? ""}`);
      if (refused) return say(refused.speech, { reason: refused.reason }, true);
      const dup = a.findOpenDuplicate(p.contact.id, details);
      if (dup) return say(`${p.contact.name} already has that task. ${a.statusSpeech(dup)}`, { duplicate: true, ...taskView(a, dup) });
      const late = a.afterHoursNote(p.contact);
      return gate(
        "assign_task",
        `${p.contact.id}|${norm(details)}|${when?.text ?? ""}`,
        confirmed,
        confirmationToken,
        () => {
          const by = when && !details.toLowerCase().includes(when.text.replace(/^by |^in /, "")) ? `, ${when.text}` : "";
          return {
            speech: `I'll call ${p.contact.name} and ask them to ${lowerFirst(details)}${by}.${late ? ` ${late}` : ""} Shall I go ahead?`,
            data: { person: p.contact.name, personRole: p.contact.label, task: details, due: when?.text, ...(late ? { afterHours: late } : {}) },
          };
        },
        () => ({
          task: a.startTask({ kind: "task", contact: p.contact, details, due: when }),
          speech: late ? `Okay. ${late}` : `Calling ${p.contact.name} now. I'll let you know what they say.`,
        }),
      );
    }),
  );

  // -------------------------------------------------------------- run_errand
  server.registerTool(
    "run_errand",
    {
      title: "Run an errand",
      description:
        "Runs one of the user's predefined errands by phone, such as getting a coffee or tea, lunch, or the car: CallAssist calls the right person with the set message and brings back their answer. Synonyms: get me, bring me, order, I want, I need. Call first without confirmed to get a read-back; call again with confirmed=true and the confirmationToken only after the user says yes.",
      inputSchema: {
        request: z.string().min(1).max(200).describe("What the user wants, e.g. 'a coffee', 'chai', 'lunch', 'the car'"),
        place: z.string().max(40).optional().describe("Where, e.g. office or home. Defaults to the office"),
        notes: z.string().max(150).optional().describe("Extra detail to pass on, e.g. 'less sugar'"),
        confirmed: z.boolean().optional().describe("Set true only after the user explicitly said yes to the read-back. Always send confirmationToken with it"),
        confirmationToken: z.string().max(64).optional().describe("IMPORTANT: required with confirmed=true. Copy it exactly from the read-back result; it proves the user heard that read-back and said yes"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
      outputSchema: OUTPUT,
    },
    wrap("run_errand", ({ request, place, notes, confirmed, confirmationToken }: { request: string; place?: string; notes?: string; confirmed?: boolean; confirmationToken?: string }) => {
      if (EMERGENCY.test(`${request} ${notes ?? ""}`)) return say("I can't help with emergencies. For an emergency, call 911 right away.", { reason: "emergency" }, true);
      if (CHILDREN.test(`${request} ${notes ?? ""}`)) return say("Sorry, to protect children's privacy, CallAssist can't take tasks about kids.", { reason: "children" }, true);
      const matches = matchErrand(store, request, place);
      if (!matches.length) {
        const known = [...new Set(store.errands.map((e) => e.name.toLowerCase()))].slice(0, 4).join(", ");
        return say(`I don't have an errand set up for that. I can arrange ${known}. Or tell me who should do it.`, { reason: "no_errand" }, true);
      }
      const errand = matches[0];
      const contact = store.contact(errand.contactId);
      if (!contact) return say("That errand isn't set up correctly. Please check it on the CallAssist page.", { reason: "bad_errand" }, true);
      const note = notes ? clean(notes).replace(/[.!]+$/, "") : "";
      const message = clean(errand.message.replaceAll("{user}", store.user.name)) + (note ? ` Note: ${note}.` : "");
      const refused = a.refusal(contact, message);
      if (refused) return say(refused.speech, { reason: refused.reason }, true);
      const dup = a.findOpenDuplicate(contact.id, message);
      if (dup) return say(`I already asked ${contact.name} for that. ${a.statusSpeech(dup)}`, { duplicate: true, ...taskView(a, dup) });
      const late = a.afterHoursNote(contact);
      return gate(
        "run_errand",
        `${errand.id}|${norm(message)}`,
        confirmed,
        confirmationToken,
        () => ({
          speech: `I'll call ${contact.name} at the ${contact.label} and say: "${message}"${late ? ` ${late}` : ""} Shall I go ahead?`,
          data: { errand: errand.name, place: errand.place, person: contact.name, personRole: contact.label, message, question: errand.question, ...(late ? { afterHours: late } : {}) },
        }),
        () => ({
          task: a.startTask({ kind: "errand", contact, title: errand.name, details: message, question: errand.question }),
          speech: late ? `Okay. ${late}` : `Calling ${contact.name} now. I'll let you know what they say.`,
        }),
      );
    }),
  );

  // --------------------------------------------------------- deliver_message
  server.registerTool(
    "deliver_message",
    {
      title: "Deliver a message by phone",
      description:
        "Has CallAssist call one of the user's people, deliver a message in its AI voice, optionally ask one question, and bring back the reply. It does not connect the user into a live call. Use for 'let Grandma know…', 'ask Ravi whether…'. Call first without confirmed to get a read-back; call again with confirmed=true and the confirmationToken only after the user says yes.",
      inputSchema: {
        person: z.string().min(1).max(60).describe("Name, nickname or role"),
        message: z.string().min(1).max(300).describe("The message to deliver"),
        question: z.string().max(200).optional().describe("One question to ask and bring back the answer"),
        confirmed: z.boolean().optional().describe("Set true only after the user explicitly said yes to the read-back. Always send confirmationToken with it"),
        confirmationToken: z.string().max(64).optional().describe("IMPORTANT: required with confirmed=true. Copy it exactly from the read-back result; it proves the user heard that read-back and said yes"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
      outputSchema: OUTPUT,
    },
    wrap("deliver_message", ({ person, message, question, confirmed, confirmationToken }: { person: string; message: string; question?: string; confirmed?: boolean; confirmationToken?: string }) => {
      const p = onePerson(store, person);
      if ("error" in p) return p.error;
      const msg = clean(message);
      const q = question ? clean(question) : undefined;
      if (!msg) return say("What message should I pass on?", { reason: "empty_message" }, true);
      const refused = a.refusal(p.contact, `${msg} ${q ?? ""}`);
      if (refused) return say(refused.speech, { reason: refused.reason }, true);
      const dup = a.findOpenDuplicate(p.contact.id, msg);
      if (dup) return say(`I'm already calling ${p.contact.name} with that message.`, { duplicate: true, ...taskView(a, dup) });
      const late = a.afterHoursNote(p.contact);
      return gate(
        "deliver_message",
        `${p.contact.id}|${norm(msg)}|${norm(q ?? "")}`,
        confirmed,
        confirmationToken,
        () => ({
          speech: `I'll call ${p.contact.name} and say: "${msg}"${q ? ` and ask: ${q}` : ""}.${late ? ` ${late}` : ""} Shall I go ahead?`,
          data: { person: p.contact.name, personRole: p.contact.label, message: msg, question: q, ...(late ? { afterHours: late } : {}) },
        }),
        () => ({
          task: a.startTask({ kind: "message", contact: p.contact, title: `Message for ${p.contact.name}`, details: msg, question: q }),
          speech: late ? `Okay. ${late}` : `Calling ${p.contact.name} now. I'll tell you what they say.`,
        }),
      );
    }),
  );

  // --------------------------------------------------------- get_task_status
  server.registerTool(
    "get_task_status",
    {
      title: "Check on a task",
      description:
        "Reports on ONE task: still calling, accepted with a time, done, declined, or waiting on the user. With no taskId it picks the named person's latest task, or the most recent one. For several tasks at once use list_tasks. Safe to call repeatedly. Use for 'what did Raju say?', 'is the coffee coming?', 'any update?'.",
      inputSchema: {
        taskId: z.string().max(64).optional().describe("The taskId from when the task started"),
        person: z.string().max(60).optional().describe("Whose task to check"),
        waitSeconds: z.number().int().min(0).max(25).optional().describe("Wait up to this many seconds for the current call to finish"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      outputSchema: OUTPUT,
    },
    wrap("get_task_status", async ({ taskId, person, waitSeconds }: { taskId?: string; person?: string; waitSeconds?: number }) => {
      const r = pickTask(store, taskId, person);
      if ("error" in r) return r.error;
      const t = (await waitForChange(a, r.task.id, waitSeconds ?? 0)) ?? r.task;
      return say(a.statusSpeech(t), taskView(a, t));
    }),
  );

  // -------------------------------------------------------------- list_tasks
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "Lists SEVERAL tasks at once (up to 5 spoken): what's open, what's done, or everything one person has. For one task's details use get_task_status. Use for 'what's pending?', 'what's Raju doing?', 'what got done?'.",
      inputSchema: {
        filter: z.enum(["open", "done", "all"]).optional().describe("open (default), done, or all"),
        person: z.string().max(60).optional().describe("Only this person's tasks"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      outputSchema: OUTPUT,
    },
    wrap("list_tasks", ({ filter, person }: { filter?: "open" | "done" | "all"; person?: string }) => {
      let list = store.sortedTasks().filter((t) => t.title !== `${t.assigneeName} called`);
      if (person) {
        const p = onePerson(store, person);
        if ("error" in p) return p.error;
        list = list.filter((t) => t.assigneeId === p.contact.id);
      }
      const f = filter ?? "open";
      if (f === "open") list = list.filter((t) => OPEN_TASK.includes(t.status));
      if (f === "done") list = list.filter((t) => t.status === "done");
      if (!list.length) return say(f === "open" ? "Nothing is pending. You're all caught up." : f === "done" ? "Nothing is finished yet." : "No tasks yet.", { tasks: [] });
      const top = list.slice(0, 5);
      const lines = top.map((t) => `${t.assigneeName}: ${t.title}, ${a.statusWord(t)}${t.eta && t.status === "accepted" ? ` ${t.eta}` : ""}`);
      const more = list.length > 5 ? ` And ${list.length - 5} more.` : "";
      const head = f === "open" ? `You have ${list.length} open ${list.length === 1 ? "task" : "tasks"}.` : f === "done" ? `${list.length} done.` : `${list.length} tasks.`;
      return say(`${head} ${lines.join(". ")}.${more}`, { tasks: list.slice(0, 20).map((t) => taskView(a, t)), total: list.length });
    }),
  );

  // --------------------------------------------------------------- follow_up
  server.registerTool(
    "follow_up",
    {
      title: "Follow up now",
      description: "Calls the person right now to check on an open task and get an update. Use for 'check with Raju', 'chase the driver', 'follow up on the report'.",
      inputSchema: {
        taskId: z.string().max(64).optional().describe("Which task"),
        person: z.string().max(60).optional().describe("Whose task, if no taskId"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
      outputSchema: OUTPUT,
    },
    wrap("follow_up", ({ taskId, person }: { taskId?: string; person?: string }) => {
      const r = pickTask(store, taskId, person, true);
      if ("error" in r) return r.error;
      const res = a.followUp(r.task.id);
      if (!res.ok) return say(res.speech, { reason: "cannot_follow_up", ...taskView(a, r.task) }, true);
      return say(`Calling ${r.task.assigneeName} now to check on ${r.task.title}.`, taskView(a, r.task));
    }),
  );

  // --------------------------------------------------------- answer_question
  server.registerTool(
    "answer_question",
    {
      title: "Answer someone's question",
      description:
        "When a person asked a question about their task or hit a problem, CallAssist calls them back with the user's answer and asks them to go ahead. Use for 'tell him it's room 3', 'say yes, use the company card'.",
      inputSchema: {
        answer: z.string().min(1).max(300).describe("The user's answer or instruction"),
        taskId: z.string().max(64).optional().describe("Which task"),
        person: z.string().max(60).optional().describe("Who asked, if no taskId"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
      outputSchema: OUTPUT,
    },
    wrap("answer_question", ({ answer, taskId, person }: { answer: string; taskId?: string; person?: string }) => {
      let r = pickTask(store, taskId, person, true);
      if (!taskId && !person) {
        const waiting = store.openTasks().find((t) => t.status === "blocked");
        if (waiting) r = { task: waiting };
      }
      if ("error" in r) return r.error;
      const res = a.answerQuestion(r.task.id, answer);
      if (!res.ok) {
        const t = a.store.tasks.get(r.task.id)!;
        if (t.pendingAnswer) return say(res.speech, { scheduled: true, ...taskView(a, t) });
        return say(res.speech, { reason: "cannot_answer" }, true);
      }
      return say(`Calling ${r.task.assigneeName} back with your answer.`, taskView(a, a.store.tasks.get(r.task.id)!));
    }),
  );

  // ------------------------------------------------------------- cancel_task
  server.registerTool(
    "cancel_task",
    {
      title: "Cancel a task",
      description:
        "Cancels a task. If the person already started, CallAssist calls them to say it's no longer needed. Use for 'cancel the coffee', 'never mind the report'. Call first without confirmed to get a read-back; call again with confirmed=true and the confirmationToken after the user says yes.",
      inputSchema: {
        taskId: z.string().max(64).optional().describe("Which task"),
        person: z.string().max(60).optional().describe("Whose task, if no taskId"),
        notifyPerson: z.boolean().optional().describe("Call the person to tell them (default true)"),
        confirmed: z.boolean().optional().describe("Set true only after the user explicitly said yes to the read-back. Always send confirmationToken with it"),
        confirmationToken: z.string().max(64).optional().describe("IMPORTANT: required with confirmed=true. Copy it exactly from the read-back result; it proves the user heard that read-back and said yes"),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: OUTPUT,
    },
    wrap("cancel_task", ({ taskId, person, notifyPerson, confirmed, confirmationToken }: { taskId?: string; person?: string; notifyPerson?: boolean; confirmed?: boolean; confirmationToken?: string }) => {
      const r = pickTask(store, taskId, person, true);
      if ("error" in r) return r.error;
      const t = r.task;
      if (CLOSED_TASK.includes(t.status) && !confirmed) return say(`That's already ${a.statusWord(t)}.`, taskView(a, t));
      let speech = "";
      return gate(
        "cancel_task",
        t.id,
        confirmed,
        confirmationToken,
        () => ({ speech: `Cancel ${t.title} for ${t.assigneeName}?`, data: { ...taskView(a, t) } }),
        () => {
          const res = a.cancelTask(t.id, notifyPerson ?? true);
          speech = !res.ok ? res.speech : res.called ? `Cancelled. I'm calling ${t.assigneeName} to let them know.` : `Cancelled ${t.title}.`;
          return { task: store.tasks.get(t.id)!, speech };
        },
      );
    }),
  );

  // ------------------------------------------------------------ team
  server.registerTool(
    "list_team",
    {
      title: "Who's on the team",
      description:
        "Lists the people CallAssist can call for the user, with their roles, or looks one up by name, nickname or role (e.g. 'Grandma', 'the driver', 'pantry'). Use for 'who can you call?', 'who's on my team?', 'is Ravi on my list?'.",
      inputSchema: { name: z.string().min(1).max(60).optional().describe("Optional: one name, nickname or role to look up") },
      annotations: { readOnlyHint: true, openWorldHint: false },
      outputSchema: OUTPUT,
    },
    wrap("list_team", ({ name }: { name?: string }) => {
      const view = (cs: Contact[]) => cs.map((c) => ({ name: c.name, role: c.label, aliases: c.aliases, canCall: c.consent && !c.optedOut }));
      if (name) {
        const found = findContacts(store, name);
        if (!found.length) return say(`I couldn't find ${clean(name)} in your team.`, { reason: "not_found", user: store.user.name, contacts: [] }, true);
        if (found.length > 1)
          return say(`I found ${found.length}: ${found.slice(0, 5).map((c) => `${c.name}, ${c.label}`).join("; ")}. Which one?`, { reason: "ambiguous", user: store.user.name, contacts: view(found) });
        const c = found[0];
        const note = !c.consent ? " They haven't agreed to calls yet." : c.optedOut ? " They asked not to be called." : "";
        return say(`${c.name}, ${c.label}.${note}`, { user: store.user.name, contacts: view(found) });
      }
      const team = store.contacts.filter((c) => c.consent && !c.optedOut);
      if (!team.length) return say("Nobody is set up yet. Add people on the CallAssist page.", { user: store.user.name, contacts: [] });
      return say(`I can call ${team.slice(0, 6).map((c) => `${c.name}, ${c.label}`).join("; ")}.`, { user: store.user.name, contacts: view(store.contacts) });
    }),
  );

  server.registerTool(
    "list_errands",
    {
      title: "List errands",
      description: "Lists the predefined errands CallAssist can run, such as coffee, tea, lunch or the car. Use for 'what can you get me?'.",
      inputSchema: { place: z.string().max(40).optional().describe("Optional place, such as office or home") },
      annotations: { readOnlyHint: true, openWorldHint: false },
      outputSchema: OUTPUT,
    },
    wrap("list_errands", ({ place }: { place?: string }) => {
      const list = store.errands.filter((e) => !place || norm(e.place) === norm(place));
      if (!list.length) return say(place ? `I don't have any errands set up for ${place}.` : "No errands are set up yet.", { errands: [] });
      return say(`I can arrange ${list.slice(0, 5).map((e) => e.name.toLowerCase()).join(", ")}. You can also ask me to give anyone on your team a task.`, {
        errands: list.map((e) => ({ name: e.name, place: e.place, person: store.contact(e.contactId)?.name, triggers: e.triggers })),
      });
    }),
  );

  return server;
}

/** Logs keep the shape of a request, not what people said (no personal data in logs). */
export function redact(args: unknown): Record<string, string> {
  if (!args || typeof args !== "object") return {};
  return Object.fromEntries(Object.entries(args as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? `<${v.length} chars>` : typeof v === "boolean" || typeof v === "number" ? String(v) : `<${typeof v}>`]));
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
