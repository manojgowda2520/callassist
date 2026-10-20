// Test harness: a full CallAssist stack on a random port with fast timers,
// plus "worker bots" that answer the local phones like real people would.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Assistant, type AssistantConfig } from "../src/assistant.js";
import { createApp } from "../src/app.js";
import { Store, type SeedData } from "../src/store.js";
import { LocalPhoneNetwork, type PhoneSignal } from "../src/telephony.js";
import { AlexaBrain } from "../src/emulator/brain.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SEED: SeedData = JSON.parse(readFileSync(join(root, "data/seed.json"), "utf8"));

export const FAST: Partial<AssistantConfig> = {
  ringTimeoutMs: 400,
  silenceTimeoutMs: 600,
  retryDelayMs: 150,
  followUpGraceMs: 150,
  maxAttempts: 2,
  maxFollowUps: 2,
  tickMs: 40,
  callingHours: null,
};

export interface Env {
  store: Store;
  phone: LocalPhoneNetwork;
  assistant: Assistant;
  url: string;
  mcp: Client;
  tool: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; data: Record<string, any>; isError: boolean }>;
  brain: () => Promise<AlexaBrain>;
  close: () => Promise<void>;
  logs: Record<string, unknown>[];
}

export async function startEnv(config: Partial<AssistantConfig> = {}, seed: SeedData = SEED): Promise<Env> {
  const store = new Store(seed);
  const phone = new LocalPhoneNetwork();
  const logs: Record<string, unknown>[] = [];
  const assistant = new Assistant(store, phone, { ...FAST, ...config }, (e) => logs.push(e));
  let url = "";
  const app = createApp({ assistant, phone, publicDir: join(root, "public"), get selfMcpUrl() { return `${url}/mcp`; }, allowedHosts: ["127.0.0.1", "localhost"], allowedOrigins: ["http://localhost:8787"], log: (e) => logs.push(e), rateLimits: { mcp: 0, token: 0, alexa: 0 } });
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assistant.start();
  const mcp = await connectClient(`${url}/mcp`);
  let brain: AlexaBrain | undefined;
  return {
    store,
    phone,
    assistant,
    url,
    mcp,
    logs,
    tool: async (name, args = {}) => {
      // Like a well-behaved client: do the read-back first and pass its token.
      if (args.confirmed === true && !("confirmationToken" in args)) {
        const { confirmed: _c, ...rest } = args;
        const rb = (await mcp.callTool({ name, arguments: rest })) as CallToolResult;
        const token = (rb.structuredContent as Record<string, unknown> | undefined)?.confirmationToken;
        if (token) args = { ...args, confirmationToken: token };
        else {
          const text = rb.content?.[0]?.type === "text" ? (rb.content[0] as { text: string }).text : "";
          return { text, data: (rb.structuredContent ?? {}) as Record<string, any>, isError: !!rb.isError };
        }
      }
      const r = (await mcp.callTool({ name, arguments: args })) as CallToolResult;
      const text = r.content?.[0]?.type === "text" ? (r.content[0] as { text: string }).text : "";
      return { text, data: (r.structuredContent ?? {}) as Record<string, any>, isError: !!r.isError };
    },
    brain: async () => {
      if (!brain) {
        brain = new AlexaBrain(`${url}/mcp`);
        await brain.connect();
      }
      return brain;
    },
    close: async () => {
      assistant.stop();
      await mcp.close().catch(() => {});
      await brain?.close().catch(() => {});
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export async function connectClient(url: string, protocolVersion?: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  const rewrite: typeof fetch = async (input, init) => {
    let body = init?.body;
    if (protocolVersion && typeof body === "string" && body.includes('"initialize"')) {
      const m = JSON.parse(body);
      m.params.protocolVersion = protocolVersion;
      body = JSON.stringify(m);
    }
    return fetch(input, { ...init, body });
  };
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: rewrite }));
  return client;
}

export type BotReply = string | "reject" | "ignore" | "hangup" | "silent" | ((call: { callId: string; heard: string[]; turn: number }) => string | "hangup" | "silent");

/**
 * A worker who answers their phone. `replies` is used in order, one per call;
 * each entry is either one reply, or an array of replies for a multi-turn call.
 */
export function workerBot(env: Env, contactId: string, replies: (BotReply | BotReply[])[], delayMs = 15) {
  const queue = [...replies];
  const heardByCall = new Map<string, string[]>();
  const calls: string[] = [];
  const off = env.phone.listen(contactId, (sig: PhoneSignal) => {
    if (sig.type === "incoming") {
      calls.push(sig.callId);
      const plan = queue.length ? queue.shift()! : "ignore";
      const turns = Array.isArray(plan) ? [...plan] : [plan];
      heardByCall.set(sig.callId, []);
      const first = turns[0];
      if (first === "ignore") return;
      if (first === "reject") return void setTimeout(() => env.phone.reject(sig.callId), delayMs);
      let turn = 0;
      const step = () => {
        const next = turns[turn];
        turn++;
        if (next === undefined || next === "silent") return;
        const reply = typeof next === "function" ? next({ callId: sig.callId, heard: heardByCall.get(sig.callId) ?? [], turn }) : next;
        if (reply === "silent") return;
        if (reply === "hangup") return void env.phone.reject(sig.callId);
        env.phone.say(sig.callId, reply);
      };
      // Reply after CallAssist finishes each question.
      const offSay = env.phone.listen(contactId, (s) => {
        if (s.type === "say" && s.callId === sig.callId) {
          heardByCall.get(sig.callId)!.push(s.text);
          if (/\?\s*$/.test(s.text) || /Can you go ahead\?|Is it done\?|What's the update\?|What would you like/.test(s.text)) setTimeout(step, delayMs);
        }
        if (s.type === "hangup" && s.callId === sig.callId) offSay();
      });
      setTimeout(() => env.phone.answer(sig.callId), delayMs);
    }
  });
  return { calls, heard: heardByCall, stop: off };
}

export async function until<T>(fn: () => T | undefined | false, timeoutMs = 3000, label = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
