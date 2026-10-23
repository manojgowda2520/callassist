// The local Alexa+ emulator's "brain". Like Alexa+, it uses a language model
// (Amazon Nova Pro, see nova.ts) to pick tools from what people actually say.
// Common phrases and yes/no go through fast rules instead, and the rules are the
// fallback when the model is slow or offline, so the demo always works. It talks
// to the CallAssist MCP server over real MCP (Streamable HTTP), presenting
// itself the way the Alexa+ client does.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Planner } from "./nova.js";
import { createHash, randomBytes } from "node:crypto";

/** How the emulator signs in to CallAssist, the same way Alexa+ does. */
export interface AlexaAuthOptions {
  tokenUrl: string;
  authorizeUrl: string;
  clientId: string;
  clientSecret: string;
  resource: string;
  redirectUri: string;
}

/**
 * Alexa+'s side of OAuth: a service token (client_credentials, mcp:service) for
 * initialize and tools/list, and a user token from account linking
 * (authorization code + PKCE, mcp:tools) for tool calls.
 */
export class AlexaAccount {
  private service?: { token: string; exp: number };
  private user?: { token: string; exp: number; refresh?: string };
  private pending = new Map<string, string>(); // state → PKCE verifier

  constructor(readonly opts: AlexaAuthOptions) {}

  get linked(): boolean {
    return !!this.user;
  }

  unlink(): void {
    this.user = undefined;
  }

  private basic(): string {
    return "Basic " + Buffer.from(`${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`).toString("base64");
  }

  private async token(form: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const res = await fetch(this.opts.tokenUrl, { method: "POST", headers: { authorization: this.basic(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    const body = await res.json();
    if (!res.ok) throw new Error(`token endpoint: ${body.error ?? res.status}`);
    return body;
  }

  async serviceToken(): Promise<string> {
    if (this.service && this.service.exp > Date.now() + 30_000) return this.service.token;
    const t = await this.token({ grant_type: "client_credentials", scope: "mcp:service", resource: this.opts.resource });
    this.service = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 };
    return t.access_token;
  }

  async userToken(): Promise<string | undefined> {
    if (!this.user) return undefined;
    if (this.user.exp > Date.now() + 30_000) return this.user.token;
    if (!this.user.refresh) return (this.user = undefined);
    try {
      const t = await this.token({ grant_type: "refresh_token", refresh_token: this.user.refresh });
      this.user = { token: t.access_token, exp: Date.now() + t.expires_in * 1000, refresh: t.refresh_token };
      return t.access_token;
    } catch {
      this.user = undefined;
      return undefined;
    }
  }

  /** Step 1 of account linking: the URL the user opens to approve. */
  startLink(): string {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(12).toString("base64url");
    this.pending.set(state, verifier);
    const u = new URL(this.opts.authorizeUrl);
    u.search = new URLSearchParams({ response_type: "code", client_id: this.opts.clientId, redirect_uri: this.opts.redirectUri, scope: "mcp:tools", state, code_challenge: challenge, code_challenge_method: "S256", resource: this.opts.resource }).toString();
    return u.toString();
  }

  /** Step 2: the redirect came back with a code; swap it for tokens. */
  async finishLink(code: string, state: string): Promise<void> {
    const verifier = this.pending.get(state);
    this.pending.delete(state);
    if (!verifier) throw new Error("Unknown or reused state.");
    const t = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.opts.redirectUri, code_verifier: verifier, resource: this.opts.resource });
    this.user = { token: t.access_token, exp: Date.now() + t.expires_in * 1000, refresh: t.refresh_token };
  }

  /** Links without a person clicking Allow (tests and unattended demos). */
  async autoLink(): Promise<void> {
    const url = new URL(this.startLink());
    url.searchParams.set("approve", "yes");
    const res = await fetch(url, { redirect: "manual" });
    const loc = new URL(res.headers.get("location") ?? "", this.opts.redirectUri);
    const code = loc.searchParams.get("code");
    if (!code) throw new Error(`linking failed: ${loc.searchParams.get("error")}`);
    await this.finishLink(code, loc.searchParams.get("state") ?? "");
  }
}

export interface McpTraffic {
  at: string;
  direction: "request" | "response";
  body: unknown;
}

export interface ToolTrace {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown> | undefined;
  isError: boolean;
  raw?: CallToolResult;
}

/** What the browser needs to render a tool's MCP Apps view. */
export interface AppView {
  resourceUri: string;
  tool: string;
  input: Record<string, unknown>;
  result: CallToolResult;
}

export interface Turn {
  speech: string;
  /** What understood the request: the fast rules, the language model, or the rules after the model failed. */
  brain?: string;
  card?: Record<string, unknown>;
  ui?: AppView;
  tools: ToolTrace[];
  expectsReply: boolean;
}

interface TeamMember {
  name: string;
  role: string;
  aliases: string[];
}

interface Session {
  pending?: { tool: string; args: Record<string, unknown> };
  history: { who: "user" | "alexa"; text: string }[];
  lastTaskId?: string;
  lastPerson?: string;
}

export const LINK_SPEECH = "To use CallAssist, link your account in the Alexa app first.";

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|please do|confirm|correct|right|haan|ha|yes please|go for it|absolutely|of course)\b/;
const NO = /^(no|nope|nah|don't|do not|never mind|nevermind|stop|cancel that|not now|wait)\b/;

/** Read-only and follow-up requests are short and predictable: the rules answer them instantly. */
const QUICK_TOOLS = new Set(["list_tasks", "get_task_status", "list_team", "list_errands", "follow_up", "cancel_task"]);
/** The phrases suggested on screen (public/alexa.html) always take the instant path, so the demo is repeatable. */
const SUGGESTED = new Set(
  [
    "Get me a coffee",
    "Ask Raju to bring tea and snacks to the meeting room by 3 pm",
    "Tell Grandma I'll pick her up at 5 and ask if she needs anything from the store",
    "Have Lakshmi make dinner for 4 people tonight",
  ].map((p) => normalize(p)),
);

/** Alexa+ sends protocol 2025-03-26 with this client name; we copy that. */
function alexaLikeFetch(onTraffic: (t: McpTraffic) => void, account?: AlexaAccount): typeof fetch {
  return async (input, init) => {
    let body = init?.body;
    const headers = new Headers(init?.headers);
    if (typeof body === "string") {
      try {
        const msg = JSON.parse(body);
        if (msg.method === "initialize") {
          msg.params.protocolVersion = "2025-03-26";
          msg.params.clientInfo = { name: "Alexa+ MCP Client (CallAssist local emulator)", version: "1.0.0" };
          // roots, as Alexa+ sends; plus the MCP Apps UI extension this emulator can render.
          msg.params.capabilities = { roots: {}, extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
          body = JSON.stringify(msg);
        }
        onTraffic({ at: new Date().toISOString(), direction: "request", body: msg });
        if (account) {
          // Service token only for the handshake and listing; anything touching the user's data needs the linked user token.
          const isTool = !["initialize", "notifications/initialized", "tools/list", "ping"].includes(msg.method);
          const token = isTool ? await account.userToken() : await account.serviceToken();
          if (token) headers.set("authorization", `Bearer ${token}`);
          else if (isTool) headers.delete("authorization");
        }
      } catch {
        // not JSON; pass through
      }
    }
    const res = await fetch(input, { ...init, body, headers });
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("application/json") || type.includes("text/event-stream")) {
      const text = await res.clone().text();
      const payloads = type.includes("event-stream")
        ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
        : [text];
      for (const p of payloads) {
        try {
          if (p) onTraffic({ at: new Date().toISOString(), direction: "response", body: JSON.parse(p) });
        } catch {
          // ignore partial frames
        }
      }
    }
    return res;
  };
}

export class AlexaBrain {
  private client?: Client;
  private team: TeamMember[] = [];
  private triggers: string[] = [];
  private errands: string[] = [];
  private tools: Tool[] = [];
  private user = "the user";
  private sessions = new Map<string, Session>();
  negotiatedVersion?: string;

  constructor(
    private mcpUrl: string,
    private onTraffic: (t: McpTraffic) => void = () => {},
    readonly account?: AlexaAccount,
    readonly planner?: Planner,
  ) {}

  async connect(): Promise<void> {
    if (this.client) return;
    const client = new Client({ name: "alexa-plus-emulator", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), { fetch: alexaLikeFetch(this.onTraffic, this.account) });
    await client.connect(transport);
    this.client = client;
    this.negotiatedVersion = (transport as unknown as { protocolVersion?: string }).protocolVersion;
    await this.listTools().catch(() => {});
    await this.refresh();
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  private uiByTool = new Map<string, string>();

  async listTools() {
    await this.connect();
    const tools = (await this.client!.listTools()).tools;
    this.tools = tools;
    for (const t of tools) {
      const meta = t._meta as { ui?: { resourceUri?: string } } | undefined;
      if (meta?.ui?.resourceUri) this.uiByTool.set(t.name, meta.ui.resourceUri);
    }
    return tools;
  }

  /** MCP Apps: fetch a tool's ui:// view from the server. */
  async readResource(uri: string): Promise<{ html: string; mimeType?: string }> {
    await this.connect();
    const r = await this.client!.readResource({ uri });
    const c = r.contents[0] as { text?: string; mimeType?: string } | undefined;
    return { html: c?.text ?? "", mimeType: c?.mimeType };
  }

  /** A tool call coming from an MCP Apps view (a button on the card). */
  async callFromView(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const t = await this.call(tool, args);
    return t.raw ?? { content: [{ type: "text", text: String(t.result?.speech ?? "") }], structuredContent: t.result, isError: t.isError };
  }

  /** Reload the team and errand words used to understand requests. */
  async refresh(): Promise<void> {
    if (this.account && !this.account.linked) return;
    const team = await this.call("list_team", {});
    if (typeof team.result?.user === "string") this.user = team.result.user;
    this.team = ((team.result?.contacts as TeamMember[] | undefined) ?? []).map((c) => ({ ...c, aliases: c.aliases ?? [] }));
    const errands = await this.call("list_errands", {});
    const list = (errands.result?.errands as { name: string; place?: string; triggers: string[] }[] | undefined) ?? [];
    this.triggers = [...new Set(list.flatMap((e) => e.triggers))];
    this.errands = list.map((e) => (e.place ? `${e.name} (${e.place})` : e.name));
  }

  async call(tool: string, args: Record<string, unknown>): Promise<ToolTrace> {
    await this.connect();
    try {
      const res = (await this.client!.callTool({ name: tool, arguments: args })) as CallToolResult;
      return { tool, args, result: res.structuredContent as Record<string, unknown> | undefined, isError: !!res.isError, raw: res };
    } catch (err) {
      if (/401|Unauthorized|linking/i.test(String(err))) {
        this.account?.unlink();
        return { tool, args, result: { speech: LINK_SPEECH, reason: "link_required" }, isError: true };
      }
      throw err;
    }
  }

  session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) this.sessions.set(id, (s = { history: [] }));
    return s;
  }

  /** Handle one thing the user said. */
  async handle(sessionId: string, raw: string): Promise<Turn> {
    const s = this.session(sessionId);
    const turn = await this.respond(s, raw);
    if (raw.trim()) s.history.push({ who: "user", text: raw.trim().slice(0, 300) }, { who: "alexa", text: turn.speech });
    s.history.splice(0, Math.max(0, s.history.length - 12));
    return turn;
  }

  private async respond(s: Session, raw: string): Promise<Turn> {
    await this.connect();
    const u = normalize(raw);
    if (this.account && !this.account.linked) return { speech: LINK_SPEECH, card: { tool: "link", reason: "link_required" }, tools: [], expectsReply: false };
    if (!this.team.length) await this.refresh().catch(() => {});
    if (!u) return { speech: "Sorry, I didn't hear anything.", tools: [], expectsReply: false };

    if (s.pending) {
      const pending = s.pending;
      if (YES.test(u)) {
        s.pending = undefined;
        return this.run(s, pending.tool, { ...pending.args, confirmed: true });
      }
      if (NO.test(u)) {
        s.pending = undefined;
        return { speech: "Okay, I won't.", tools: [], expectsReply: false };
      }
    }
    // Anything else replaces the pending read-back, unless the model reads it as a correction to it.
    const previous = s.pending;
    s.pending = undefined;

    // Fast rules for yes/no-style and read-only requests; the model for everything said freely.
    const rule = this.understand(u, s);
    let intent: { tool: string; args: Record<string, unknown>; answer?: string } | undefined;
    let brain = "rules";
    if (rule && (QUICK_TOOLS.has(rule.tool) || SUGGESTED.has(u) || !this.planner)) intent = rule;
    else if (this.planner) {
      try {
        if (!this.tools.length) await this.listTools();
        const plan = await this.planner.plan(raw.trim(), this.tools, { user: this.user, team: this.team, errands: this.errands, lastPerson: s.lastPerson, history: [...s.history], pending: previous });
        brain = this.planner.name;
        if ("speech" in plan) return { speech: plan.speech, brain, tools: [], expectsReply: /\?\s*$/.test(plan.speech) };
        intent = { tool: plan.tool, args: plan.args, answer: plan.tool === "deliver_message" && typeof plan.args.message === "string" ? plan.args.message : undefined };
      } catch (err) {
        console.log(JSON.stringify({ at: new Date().toISOString(), event: "alexa_model_fallback", error: String(err).slice(0, 200) }));
        intent = rule;
        brain = "rules (model unavailable)";
        if (!intent) s.pending = previous;
      }
    }
    if (!intent) {
      return {
        speech: "I can give someone on your team a task, run an errand like getting you a coffee, pass on a message, or check on your tasks. What would you like?",
        brain,
        tools: [],
        expectsReply: true,
      };
    }
    // A "tell X …" right after X asked a question is the answer to it.
    if (intent.tool === "deliver_message" && typeof intent.args.person === "string" && intent.answer) {
      const open = await this.call("list_tasks", { filter: "open", person: intent.args.person });
      const tasks = (open.result?.tasks as { status: string; taskId: string }[] | undefined) ?? [];
      const waiting = tasks.find((t) => t.status === "blocked");
      if (waiting) return { ...(await this.run(s, "answer_question", { taskId: waiting.taskId, answer: intent.answer })), brain };
    }
    return { ...(await this.run(s, intent.tool, intent.args)), brain };
  }

  private async run(s: Session, tool: string, args: Record<string, unknown>): Promise<Turn> {
    const trace = await this.call(tool, args);
    const r = trace.result ?? {};
    if (typeof r.taskId === "string") s.lastTaskId = r.taskId;
    if (typeof r.person === "string") s.lastPerson = r.person;
    const needs = r.needsConfirmation === true;
    if (needs) {
      const { confirmed: _c, confirmationToken: _t, ...rest } = args;
      s.pending = { tool, args: { ...rest, confirmationToken: r.confirmationToken } };
    }
    if (tool === "list_team" || tool === "list_errands") void this.refresh().catch(() => {});
    const uri = this.uiByTool.get(tool);
    const ui = uri && trace.raw && !trace.isError ? { resourceUri: uri, tool, input: args, result: trace.raw } : undefined;
    return { speech: String(r.speech ?? "Done."), card: { tool, ...r }, ui, tools: [trace], expectsReply: needs || r.reason === "ambiguous" };
  }

  // ------------------------------------------------------------------ rules

  understand(u: string, _s?: Session): { tool: string; args: Record<string, unknown>; answer?: string } | undefined {
    const person = this.personIn(u);
    let m: RegExpMatchArray | null;

    if (/^(help|what can you do|what do you do|how does this work)\b/.test(u) || /\bwhat can you (get|do|arrange)\b/.test(u)) return { tool: "list_errands", args: {} };
    if (/\b(who('s| is) on my team|who can you call|my team|list (my )?(team|people|staff|contacts))\b/.test(u)) return { tool: "list_team", args: {} };

    // Answering a question a worker asked: "tell him it's room 3"
    if ((m = u.match(/^(?:tell|say to|let) (him|her|them)(?: know)?(?: that)? (.+)$/))) return { tool: "answer_question", args: { answer: toThirdPerson(m[2], this.userName()) } };
    if ((m = u.match(/^(?:the answer is|answer|reply) (.+)$/))) return { tool: "answer_question", args: { answer: m[1] } };

    // Delegation: "ask Raju to …", "have the driver …", "Raju should …", "assign … to Raju"
    const name = person ? escape(person.spoken) : undefined;
    if (name && person) {
      const due = (t: string) => {
        const d = t.match(/\b(by \d{1,2}(:\d{2})? ?(am|pm)?|in \d+ (minutes|mins|hours?)|in (half an|an) hour|today|tonight|tomorrow( morning)?|by (end of day|eod|tonight|tomorrow))\b/);
        return d ? d[0] : undefined;
      };
      const assign = (task: string) => {
        const t = toThirdPerson(task, this.userName());
        const d = due(t);
        return { tool: "assign_task", args: { person: person.name, task: d ? t.replace(d, "").replace(/\s+/g, " ").trim() : t, ...(d ? { due: d } : {}) } };
      };
      if ((m = u.match(new RegExp(`^(?:can you |could you |please )?(?:ask|tell|have|get|make|remind|need|i need|i want) (?:the )?${name} to (.+)$`)))) return assign(m[1]);
      if ((m = u.match(new RegExp(`^(?:the )?${name} (?:should|needs to|must|has to|will need to|ought to) (.+)$`)))) return assign(m[1]);
      if ((m = u.match(new RegExp(`^(?:assign|give|delegate) (.+?) to (?:the )?${name}$`)))) return assign(m[1]);
      if ((m = u.match(new RegExp(`^(?:have|get|make) (?:the )?${name} (.+)$`)))) return assign(m[1]);

      // Messages: "tell Grandma I'll pick her up at 5 and ask if she needs anything"
      if ((m = u.match(new RegExp(`^(?:can you |please )?(?:tell|let|inform|message) (?:the )?${name}(?: know)?(?: that)? (.+?)(?:,? and ask (?:(?:him|her|them) )?(.+))?$`)))) {
        return {
          tool: "deliver_message",
          args: { person: person.name, message: toRecipient(m[1], this.userName()), ...(m[2] ? { question: toQuestion(m[2]) } : {}) },
          answer: toThirdPerson(m[1], this.userName()),
        };
      }
      if ((m = u.match(new RegExp(`^(?:can you |please )?ask (?:the )?${name} (.+)$`)))) {
        return { tool: "deliver_message", args: { person: person.name, message: `${this.userName()} has a quick question.`, question: toQuestion(m[1]) } };
      }
    }

    if (/^(please |can you |could you )?(cancel|call off|scrap|forget about|never mind about|i no longer need|i don't need)\b/.test(u))
      return { tool: "cancel_task", args: this.withPerson({}, person) };

    if (/^(please |can you |could you )?(follow up|follow-up|check with|check on|chase|ping|remind)\b/.test(u) && !/\bremind (the )?\w+( \w+)? to\b/.test(u))
      return { tool: "follow_up", args: this.withPerson({}, person) };

    if (/\b(what'?s|what is|anything) (pending|open|left|outstanding|going on)\b|\bmy (tasks|to ?do|list)\b|\bto-?do list\b|\bwhat('s| is) on (my )?(plate|list)\b/.test(u))
      return { tool: "list_tasks", args: this.withPerson({ filter: "open" }, person) };
    if (/\bwhat (got|has been|was) (done|finished|completed)\b|\bwhat('s| is) done\b/.test(u)) return { tool: "list_tasks", args: { filter: "done" } };
    if ((m = u.match(/\bwhat(?: is|'s) (\w+) (doing|working on|up to)\b/))) return { tool: "list_tasks", args: this.withPerson({ filter: "open" }, person) };

    if (/\b(any )?(update|news|status|progress)\b|\bwhat did \w+( \w+)? say\b|\bdid \w+( \w+)? (reply|answer|say|respond|pick up)\b|\bis (the |my )?.+ (coming|done|ready|on (its|the) way)\b|\bwhere('s| is) (my|the) \w+\b|\bhow('s| is) .+ going\b/.test(u))
      return { tool: "get_task_status", args: this.withPerson({}, person) };

    // Errands: "get me a coffee", "chai please", "I need the car at home"
    const trigger = this.triggers.find((t) => new RegExp(`\\b${escape(t)}s?\\b`).test(u));
    if (trigger) {
      const place = /\b(at home|home)\b/.test(u) ? "home" : /\b(at (the )?office|office|work)\b/.test(u) ? "office" : undefined;
      const notes = u.match(/\b((?:with |without )?(?:no |less |extra |more )?(?:sugar|milk|ice|spice|spicy|salt|cream|foam|hot)[\w ]*)$/)?.[1];
      return { tool: "run_errand", args: { request: u, ...(place ? { place } : {}), ...(notes ? { notes } : {}) } };
    }
    return undefined;
  }

  private personIn(u: string): { name: string; spoken: string } | undefined {
    const options: { name: string; spoken: string }[] = [];
    for (const c of this.team) {
      options.push({ name: c.name, spoken: c.name.toLowerCase() });
      for (const a of c.aliases) options.push({ name: c.name, spoken: a.toLowerCase() });
      options.push({ name: c.name, spoken: c.role.toLowerCase() });
      const first = c.name.split(" ")[0].toLowerCase();
      if (first !== c.name.toLowerCase()) options.push({ name: first, spoken: first });
    }
    options.sort((a, b) => b.spoken.length - a.spoken.length);
    return options.find((o) => o.spoken && new RegExp(`\\b${escape(o.spoken)}\\b`).test(u));
  }

  private withPerson(args: Record<string, unknown>, person?: { name: string }) {
    return person ? { ...args, person: person.name } : args;
  }

  private userName(): string {
    return this.user;
  }
}

// ------------------------------------------------------------------ language helpers

export function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/^\s*(hey |ok |okay )?alexa[,!.]?\s*/, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "bring my laptop to me" → "bring Manoj's laptop to Manoj" (the worker hears it from CallAssist). */
export function toThirdPerson(text: string, user: string): string {
  return text
    .replace(/\bI'm\b/gi, `${user} is`)
    .replace(/\bI'll\b/gi, `${user} will`)
    .replace(/\bI've\b/gi, `${user} has`)
    .replace(/\bI'd\b/gi, `${user} would`)
    .replace(/\bmy\b/gi, `${user}'s`)
    .replace(/\bmine\b/gi, `${user}'s`)
    .replace(/\bme\b/gi, user)
    .replace(/\bI am\b/gi, `${user} is`)
    .replace(/\bI\b/g, user)
    .replace(/(^|\s)i(\s)/g, `$1${user}$2`)
    .replace(/\s+/g, " ")
    .trim();
}

/** A message for the recipient: first person → the user, him/her → you. */
export function toRecipient(text: string, user: string): string {
  const t = toThirdPerson(text, user)
    .replace(/\b(she|he|they) (needs|wants|has|is|was)\b/gi, (_m, _p, v: string) => `you ${({ needs: "need", wants: "want", has: "have", is: "are", was: "were" } as Record<string, string>)[v.toLowerCase()]}`)
    .replace(/\b(her|him|them)\b/gi, "you")
    .replace(/\b(she|he|they)\b/gi, "you");
  return t.charAt(0).toUpperCase() + t.slice(1).replace(/[.!]?$/, ".");
}

/** "if she needs anything from the store" → "Do you need anything from the store?" */
export function toQuestion(text: string): string {
  let t = text.trim().replace(/^(him|her|them) /, "").replace(/^(if|whether) /, "");
  const verbs: Record<string, string> = { needs: "Do you need", wants: "Do you want", has: "Do you have", is: "Are you", can: "Can you", will: "Will you", could: "Could you", would: "Would you", knows: "Do you know", likes: "Do you like", needed: "Did you need", got: "Did you get", did: "Did you", was: "Were you" };
  const m = t.match(/^(she|he|they|you) (\w+) ?(.*)$/i);
  if (m && verbs[m[2].toLowerCase()]) t = `${verbs[m[2].toLowerCase()]} ${m[3]}`.trim();
  else if (m && m[1].toLowerCase() === "they" && /^(need|want|have|know|like)$/.test(m[2])) t = `Do you ${m[2]} ${m[3]}`.trim();
  else if (/^(the|a|an|there|it) /i.test(t)) {
    const n = t.match(/^(.+?) (is|are|was|were|can|will) (.+)$/i);
    if (n) t = `${n[2].charAt(0).toUpperCase()}${n[2].slice(1)} ${n[1]} ${n[3]}`;
  }
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.replace(/[.?!]*$/, "?");
}
