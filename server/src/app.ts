// HTTP app: the MCP endpoint, the phone-agent MCP endpoint, the local phone
// network, the Alexa+ emulator API, and the web pages.
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { Assistant } from "./assistant.js";
import { createMcpServer, taskView } from "./mcp.js";
import { createAgentMcpServer } from "./agentMcp.js";
import { LocalPhoneNetwork, type PhoneSignal } from "./telephony.js";
import type { Store, StoreEvent } from "./store.js";
import { AlexaAccount, AlexaBrain, type AlexaAuthOptions, type McpTraffic } from "./emulator/brain.js";
import type { AuthServer } from "./auth.js";
import { Metrics, rateLimit } from "./ops.js";
import type { LocalOutbox } from "./email.js";
import { LocalTts, VOICES } from "./tts.js";

export interface AppOptions {
  assistant: Assistant;
  phone: LocalPhoneNetwork;
  publicDir: string;
  tts?: LocalTts;
  /** Full URL of this server's /mcp, for the emulator's MCP client. */
  selfMcpUrl?: string;
  /** Host headers accepted on /mcp (DNS-rebinding protection). Empty = allow all. */
  allowedHosts?: string[];
  /** Browser Origins accepted on /mcp; requests with any other Origin get 403. Empty = allow all. */
  allowedOrigins?: string[];
  log?: (e: Record<string, unknown>) => void;
  /** OAuth for /mcp and /agent/mcp. Off when undefined (tests, quick hacking). */
  auth?: AuthServer;
  /**
   * Each linked account's own assistant (own team, tasks and calls), chosen by
   * the token's subject. Records never cross accounts. On AWS: DynamoDB items
   * keyed by userId. Defaults to `assistant` for the auth config's userId.
   */
  accountFor?: (sub: string) => Assistant | undefined;
  /** How the emulator signs in (as Alexa+ would). Needed when auth is on. */
  alexaAuth?: AlexaAuthOptions;
  /** Local email outbox, shown on the console. */
  outbox?: LocalOutbox;
  /** Write CloudWatch EMF metric lines to the log. */
  emitMetrics?: boolean;
  /** Requests per minute per client; 0 turns limits off (tests). */
  rateLimits?: { mcp: number; token: number; alexa: number };
}

function sse(res: Response) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(": connected\n\n");
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  return {
    send: (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    onClose: (fn: () => void) =>
      res.on("close", () => {
        clearInterval(ping);
        fn();
      }),
  };
}

async function serveMcp(make: () => McpServer, req: Request, res: Response) {
  const server = make();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/** "+15550100001" → "+1 •••-•••-0001": pages never need the full number. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `+${digits.slice(0, digits.length - 10) || "1"} •••-•••-${digits.slice(-4)}` : "••••";
}

export function publicState(store: Store, a: Assistant) {
  return {
    user: store.user,
    contacts: store.contacts.map((c) => ({ id: c.id, name: c.name, label: c.label, phone: maskPhone(c.phone), consent: c.consent, optedOut: c.optedOut })),
    errands: store.errands.map((e) => ({ name: e.name, place: e.place, person: store.contact(e.contactId)?.name, triggers: e.triggers })),
    tasks: store.sortedTasks().slice(0, 50).map((t) => taskView(a, t)),
    calls: [...store.calls.values()].sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 30).map((c) => ({ ...c, phone: maskPhone(c.phone) })),
    notifications: store.notifications.slice(-30).reverse(),
  };
}

export function createApp(opts: AppOptions) {
  const { assistant, phone } = opts;
  const store = assistant.store;
  const baseLog = opts.log ?? (() => {});
  const metrics = new Metrics(opts.emitMetrics ? baseLog : () => {});
  const log = (e: Record<string, unknown>) => {
    baseLog(e);
    if (e.event === "tool") {
      metrics.count("ToolCalls", 1, { Tool: String(e.tool) });
      metrics.timing("ToolLatency", Number(e.ms ?? 0), { Tool: String(e.tool) });
      if (e.isError) metrics.count("ToolErrors", 1, { Tool: String(e.tool), Reason: String(e.reason ?? "error") });
    } else if (e.event === "tool_error") metrics.count("ToolFailures", 1, { Tool: String(e.tool) });
    else if (e.event === "auth_denied") metrics.count("AuthDenied", 1, { Reason: String(e.reason) });
  };
  store.subscribe((e) => {
    if (e.type === "call" && ["ended", "no_answer", "rejected", "cancelled", "failed"].includes(e.call.status) && !counted.has(e.call.id)) {
      counted.add(e.call.id);
      metrics.count("CallOutcome", 1, { Outcome: e.call.status, Purpose: e.call.purpose });
      metrics.timing("CallDuration", new Date(e.call.updatedAt).getTime() - new Date(e.call.createdAt).getTime(), { Purpose: e.call.purpose });
    }
    if (e.type === "task" && ["done", "declined", "unreachable", "cancelled", "accepted", "blocked"].includes(e.task.status) && lastStatus.get(e.task.id) !== e.task.status) {
      lastStatus.set(e.task.id, e.task.status);
      metrics.count("TaskStatus", 1, { Status: e.task.status, Kind: e.task.kind });
    }
  });
  const counted = new Set<string>();
  const lastStatus = new Map<string, string>();
  const app = express();
  app.set("trust proxy", "loopback");
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  const hostGuard = (req: Request, res: Response, next: () => void) => {
    const allowed = opts.allowedHosts ?? [];
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (allowed.length && !allowed.includes(host)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Host not allowed" }, id: null });
      return;
    }
    const origin = req.headers.origin;
    const origins = opts.allowedOrigins ?? [];
    if (origin && origins.length && !origins.includes(origin)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Origin not allowed" }, id: null });
      return;
    }
    next();
  };
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };

  // ---------------------------------------------------------------- MCP
  const pass = (_req: Request, _res: Response, next: () => void) => next();
  const limits = opts.rateLimits ?? { mcp: 300, token: 30, alexa: 60 };
  const limited = (name: string, perMinute: number) => (perMinute > 0 ? rateLimit({ name, perMinute, burst: Math.max(5, Math.ceil(perMinute / 3)), onLimit: () => metrics.count("RateLimited", 1, { Endpoint: name }) }) : pass);
  app.use("/oauth/token", limited("token endpoint", limits.token));
  app.use("/mcp", limited("MCP", limits.mcp));
  app.use("/api/alexa/say", limited("emulator", limits.alexa));
  if (opts.auth) app.use(opts.auth.router());
  const mcpAuth = opts.auth ? opts.auth.mcpGuard() : pass;
  const agentAuth = opts.auth ? opts.auth.agentGuard() : pass;
  app.post("/mcp", hostGuard, mcpAuth, (req, res) => {
    const sub = (req as Request & { auth?: { sub: string } }).auth?.sub;
    let account: Assistant | undefined = assistant;
    if (opts.auth && sub && !sub.startsWith("client:")) {
      account = opts.accountFor?.(sub) ?? (sub === opts.auth.config.userId ? assistant : undefined);
    }
    if (!account) return void res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    void serveMcp(() => createMcpServer(account, log), req, res);
  });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
  app.post("/agent/mcp", hostGuard, agentAuth, (req, res) => void serveMcp(() => createAgentMcpServer(assistant), req, res));
  app.get("/agent/mcp", methodNotAllowed);

  // ---------------------------------------------------------------- state + live events
  app.get("/api/state", (_req, res) => res.json(publicState(store, assistant)));
  app.get("/api/metrics", (_req, res) => res.json(metrics.snapshot()));
  app.get("/api/outbox", (_req, res) => res.json(opts.outbox?.list() ?? []));
  app.get("/outbox/:file", (req, res) => {
    const file = String(req.params.file);
    if (!opts.outbox || !/^[\w.-]+\.html$/.test(file)) return void res.status(404).end();
    res.sendFile(join(opts.outbox.dir, file), (err) => err && !res.headersSent && res.status(404).end());
  });
  app.get("/api/events", (req, res) => {
    const s = sse(res);
    const off = store.subscribe((e: StoreEvent) => {
      if (e.type === "task") s.send("task", taskView(assistant, e.task));
      else if (e.type === "call") {
        s.send("call", { ...e.call, phone: maskPhone(e.call.phone) });
        // The task's "on the phone" state depends on its call: refresh it too.
        const t = store.tasks.get(e.call.taskId);
        if (t) s.send("task", taskView(assistant, t));
      }
      else s.send("notification", e.notification);
    });
    s.onClose(off);
  });

  // ---------------------------------------------------------------- local phone network
  const audioFor = (text: string) => (opts.tts?.available ? `/tts?voice=agent&text=${encodeURIComponent(text)}` : undefined);
  app.get("/api/phone/:contactId/events", (req, res) => {
    const contact = store.contact(req.params.contactId);
    if (!contact) return void res.status(404).json({ error: "unknown contact" });
    const s = sse(res);
    s.send("hello", { contact: { id: contact.id, name: contact.name, label: contact.label, phone: maskPhone(contact.phone) }, user: store.user.name });
    const ringing = store.activeCalls().find((c) => c.contactId === contact.id && c.status === "ringing");
    if (ringing) s.send("signal", { type: "incoming", callId: ringing.id, from: "CallAssist", purpose: ringing.purpose });
    const off = phone.listen(contact.id, (sig: PhoneSignal) => s.send("signal", sig.type === "say" ? { ...sig, audio: audioFor(sig.text) } : sig));
    s.onClose(off);
  });
  const callFor = (req: Request, res: Response) => {
    const call = store.calls.get(String(req.params.callId));
    if (!call) res.status(404).json({ error: "unknown call" });
    return call;
  };
  app.post("/api/phone/calls/:callId/answer", (req, res) => {
    if (!callFor(req, res)) return;
    phone.answer(String(req.params.callId));
    res.json({ ok: true });
  });
  app.post("/api/phone/calls/:callId/say", (req, res) => {
    if (!callFor(req, res)) return;
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 500) : "";
    if (!text.trim()) return void res.status(400).json({ error: "text required" });
    phone.say(String(req.params.callId), text);
    res.json({ ok: true });
  });
  app.post("/api/phone/calls/:callId/reject", (req, res) => {
    if (!callFor(req, res)) return;
    phone.reject(String(req.params.callId));
    res.json({ ok: true });
  });
  app.post("/api/phone/:contactId/dial", (req, res) => {
    const call = assistant.inboundCall(req.params.contactId);
    if (!call) return void res.status(404).json({ error: "unknown contact" });
    res.json({ ok: true, callId: call.id });
  });

  app.get("/tts", async (req, res) => {
    const text = typeof req.query.text === "string" ? req.query.text : "";
    if (!opts.tts?.available || !text) return void res.status(404).end();
    const voice = req.query.voice === "alexa" ? VOICES.alexa : VOICES.agent;
    try {
      const file = await opts.tts.file(text, voice);
      res.set("cache-control", "public, max-age=86400").type("audio/mpeg").sendFile(file);
    } catch (err) {
      log({ event: "tts_error", error: String(err) });
      res.status(500).end();
    }
  });

  // ---------------------------------------------------------------- Alexa+ emulator
  const trafficSubs = new Set<(t: McpTraffic) => void>();
  let brain: AlexaBrain | undefined;
  const getBrain = async () => {
    if (!opts.selfMcpUrl) throw new Error("selfMcpUrl not set");
    brain ??= new AlexaBrain(opts.selfMcpUrl, (t) => trafficSubs.forEach((fn) => fn(t)), opts.alexaAuth ? new AlexaAccount(opts.alexaAuth) : undefined);
    await brain.connect();
    return brain;
  };
  app.post("/api/alexa/say", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 500) : "";
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.slice(0, 64) : "default";
    try {
      const b = await getBrain();
      const turn = await b.handle(sessionId, text);
      res.json({ ...turn, audio: opts.tts?.available ? `/tts?voice=alexa&text=${encodeURIComponent(turn.speech)}` : undefined });
    } catch (err) {
      log({ event: "alexa_error", error: String(err) });
      res.status(500).json({ speech: "Sorry, something went wrong.", tools: [], expectsReply: false });
    }
  });
  app.get("/api/alexa/info", async (_req, res) => {
    try {
      const b = await getBrain();
      res.json({ protocolVersion: b.negotiatedVersion, authRequired: !!opts.auth, linked: b.account ? b.account.linked : true, tools: (await b.listTools()).map((t) => ({ name: t.name, title: t.title, description: t.description })) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
  // Account linking, as in the Alexa app: open the consent page, come back with a code.
  app.post("/api/alexa/link", async (_req, res) => {
    const b = await getBrain();
    if (!b.account) return void res.json({ linked: true });
    res.json({ linked: b.account.linked, url: b.account.startLink() });
  });
  app.get("/alexa/callback", async (req, res) => {
    const b = await getBrain();
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error || !code || !state || !b.account) return void res.redirect(`/alexa?link_error=${encodeURIComponent(error ?? "missing_code")}`);
    try {
      await b.account.finishLink(code, state);
      await b.refresh();
      res.redirect("/alexa?linked=1");
    } catch (err) {
      log({ event: "link_error", error: String(err) });
      res.redirect("/alexa?link_error=exchange_failed");
    }
  });
  app.post("/api/alexa/unlink", async (_req, res) => {
    const b = await getBrain();
    b.account?.unlink();
    res.json({ linked: false });
  });
  app.get("/api/alexa/traffic", (req, res) => {
    const s = sse(res);
    const fn = (t: McpTraffic) => s.send("traffic", t);
    trafficSubs.add(fn);
    s.onClose(() => trafficSubs.delete(fn));
  });

  // ---------------------------------------------------------------- demo controls (local only)
  app.post("/api/demo/reset", (_req, res) => {
    assistant.stop();
    store.tasks.clear();
    store.calls.clear();
    store.notifications.length = 0;
    for (const c of store.contacts) {
      c.optedOut = false;
      c.optedOutAt = undefined;
    }
    store.touch();
    assistant.start();
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- pages
  const page = (file: string) => (_req: Request, res: Response) => res.sendFile(join(opts.publicDir, file));
  app.get("/", page("index.html"));
  app.get("/alexa", page("alexa.html"));
  app.get("/console", page("console.html"));
  app.get("/phone/:contactId", page("phone.html"));
  app.get("/phones", page("phones.html"));
  app.get("/privacy", page("privacy.html"));
  app.get("/terms", page("terms.html"));
  app.use("/static", express.static(join(opts.publicDir, "static"), { maxAge: 0 }));
  app.get("/healthz", (_req, res) => res.json({ ok: true, provider: phone.name, activeCalls: store.activeCalls().length, callingHours: assistant.config.callingHours ? "8 AM-9 PM callee time" : "off (demo)", auth: !!opts.auth }));

  // Bad JSON and other request errors: answer cleanly instead of printing a stack.
  app.use((err: { type?: string; status?: number }, _req: Request, res: Response, _next: () => void) => {
    if (err.type === "entity.parse.failed") return void res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    if (err.type === "entity.too.large") return void res.status(413).json({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null });
    log({ event: "http_error", error: String(err) });
    res.status(err.status ?? 500).json({ error: "Something went wrong" });
  });

  return app;
}
