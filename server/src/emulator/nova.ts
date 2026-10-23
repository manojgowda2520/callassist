// The emulator's language model: Amazon Nova Pro on Bedrock picks the CallAssist
// tool and fills in its arguments from whatever the user said, the way Alexa+
// uses a model to pick add-on tools. It only plans; the brain runs the tool, so
// the server's read-back and "yes" check still decide whether anyone is called.
import { BedrockRuntimeClient, ConverseCommand, type Message, type Tool as BedrockTool } from "@aws-sdk/client-bedrock-runtime";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type Plan = { tool: string; args: Record<string, unknown> } | { speech: string };

export interface PlanContext {
  user: string;
  team: { name: string; role: string; aliases: string[] }[];
  errands: string[];
  /** The person the conversation was last about, for "tell him…". */
  lastPerson?: string;
  /** The request just read back and waiting for a yes, if any. */
  pending?: { tool: string; args: Record<string, unknown> };
  /** Recent turns, oldest first. */
  history: { who: "user" | "alexa"; text: string }[];
}

export interface Planner {
  readonly name: string;
  plan(utterance: string, tools: Tool[], ctx: PlanContext): Promise<Plan>;
}

/** Fields only the brain sets after the user's spoken yes; the model never sees them. */
const HIDDEN = new Set(["confirmed", "confirmationToken"]);

export class NovaPlanner implements Planner {
  readonly name: string;
  private client: BedrockRuntimeClient;

  constructor(
    private skill: string,
    private model = "us.amazon.nova-pro-v1:0",
    private timeoutMs = 6000,
    region = process.env.AWS_REGION ?? "us-east-1",
  ) {
    this.name = model;
    this.client = new BedrockRuntimeClient({ region });
  }

  /** Opens the connection and loads credentials ahead of the first real request, which is otherwise slow. */
  async warm(): Promise<void> {
    await this.client.send(new ConverseCommand({ modelId: this.model, messages: [{ role: "user", content: [{ text: "hi" }] }], inferenceConfig: { maxTokens: 1 } })).catch(() => {});
  }

  async plan(utterance: string, tools: Tool[], ctx: PlanContext): Promise<Plan> {
    const messages: Message[] = [];
    for (const h of ctx.history.slice(-6)) {
      const role = h.who === "user" ? "user" : "assistant";
      const last = messages.at(-1);
      // Bedrock wants turns to alternate; fold repeats together.
      if (last?.role === role) last.content!.push({ text: h.text });
      else messages.push({ role, content: [{ text: h.text }] });
    }
    if (messages[0]?.role === "assistant") messages.shift();
    if (messages.at(-1)?.role === "user") messages.at(-1)!.content!.push({ text: utterance });
    else messages.push({ role: "user", content: [{ text: utterance }] });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const out = await this.client.send(
        new ConverseCommand({
          modelId: this.model,
          system: [{ text: this.system(ctx) }],
          messages,
          toolConfig: { tools: tools.map(toBedrockTool) },
          inferenceConfig: { maxTokens: 400, temperature: 0 },
        }),
        { abortSignal: abort.signal },
      );
      const content = out.output?.message?.content ?? [];
      const use = content.find((c) => c.toolUse)?.toolUse;
      if (use?.name && tools.some((t) => t.name === use.name)) {
        const args = Object.fromEntries(Object.entries((use.input ?? {}) as Record<string, unknown>).filter(([k, v]) => !HIDDEN.has(k) && v !== null && v !== ""));
        return { tool: use.name, args };
      }
      const speech = content.map((c) => c.text ?? "").join(" ").trim();
      // Only the server's read-back can lead to a call; a model imitating one is treated as a miss.
      if (speech && !/shall i go ahead|should i go ahead|want me to (go ahead|call)/i.test(speech)) return { speech };
      throw new Error("empty model reply");
    } finally {
      clearTimeout(timer);
    }
  }

  private system(ctx: PlanContext): string {
    const team = ctx.team.map((p) => `- ${p.name} (${p.role}${p.aliases.length ? `; also called ${p.aliases.join(", ")}` : ""})`).join("\n");
    return `You are Alexa+ on ${ctx.user}'s Echo Show, with the CallAssist add-on installed. Everything you say is spoken aloud, so reply in one short, natural sentence, with no lists, markdown or emoji.

When the request fits a CallAssist tool, call the tool. Never write a read-back or ask "shall I go ahead" yourself: the tool returns the read-back, and the device handles the user's yes. Never set "confirmed" or "confirmationToken". If the user changes a detail of what you just read back ("make it 4", "actually ask Ravi"), call the same tool again with the corrected arguments.

Write task text as it would be said to the worker ("set up the meeting room for the client") and put times in "due". Write messages about ${ctx.user} in the third person, as they'd be said to the person called ("${ctx.user} is running late", "${ctx.user} will pick you up at 5"), and questions directly to them ("Have you eaten?"). If the person or the request is genuinely unclear, ask one short question instead of guessing. For anything unrelated to CallAssist, answer briefly yourself.

${ctx.user}'s team:
${team || "- (nobody yet)"}

Preset errands: ${ctx.errands.join(", ") || "none"}.
${ctx.pending ? `Waiting for the user's yes on: ${ctx.pending.tool} ${JSON.stringify(Object.fromEntries(Object.entries(ctx.pending.args).filter(([k]) => !HIDDEN.has(k))))}. If they change a detail, call ${ctx.pending.tool} again with all the arguments and the change.
` : ""}${ctx.lastPerson ? `The conversation was last about ${ctx.lastPerson}; "him", "her" or "them" means ${ctx.lastPerson}.\n` : ""}
CallAssist skill instructions:
${this.skill}`;
  }
}

function toBedrockTool(t: Tool): BedrockTool {
  const schema = structuredClone(t.inputSchema) as { properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  for (const k of HIDDEN) delete schema.properties?.[k];
  if (schema.required) schema.required = schema.required.filter((k) => !HIDDEN.has(k));
  delete schema.$schema;
  return { toolSpec: { name: t.name, description: (t.description ?? t.title ?? t.name).slice(0, 1000), inputSchema: { json: schema as never } } };
}
