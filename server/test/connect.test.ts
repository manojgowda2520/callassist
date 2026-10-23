// The Amazon Connect line, with a fake Connect API: the contact flow's turns
// arrive at /connect/turn exactly as the Lambda would send them.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Assistant } from "../src/assistant.js";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { LocalPhoneNetwork } from "../src/telephony.js";
import { ConnectTelephony, TelephonyRouter, type ConnectApi } from "../src/connect.js";
import { FAST, SEED, until } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Rig {
  url: string;
  store: Store;
  assistant: Assistant;
  started: { destination: string; attributes: Record<string, string> }[];
  stopped: string[];
  close: () => Promise<void>;
}
let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

async function start(opts: { failStart?: boolean; ringTimeoutMs?: number } = {}): Promise<Rig> {
  const seed = structuredClone(SEED);
  seed.business = { ...seed.business!, callback: "+91 80 4000 0000" };
  seed.contacts.push({ id: "c_maya", name: "Maya", label: "volunteer", aliases: [], phone: "+12065550123", consent: true, optedOut: false, line: "connect", consentRecord: { at: "2026-10-22T00:00:00Z", method: "written", wording: "AI-voice calls ok" } });
  const store = new Store(seed);
  const started: Rig["started"] = [];
  const stopped: string[] = [];
  let n = 0;
  const api: ConnectApi = {
    async startCall(input) {
      if (opts.failStart) throw new Error("DestinationNotAllowedException");
      started.push(input);
      return { contactId: `contact-${++n}` };
    },
    async stopCall(id) {
      stopped.push(id);
    },
  };
  const local = new LocalPhoneNetwork();
  const connect = new ConnectTelephony(api);
  const router = new TelephonyRouter({ local, connect }, (call) => store.contact(call.contactId)?.line ?? "local");
  const assistant = new Assistant(store, router, { ...FAST, ringTimeoutMs: opts.ringTimeoutMs ?? 3000 });
  const app = createApp({ assistant, phone: local, connect, publicDir: join(root, "public"), rateLimits: { mcp: 0, token: 0, alexa: 0 } });
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  assistant.start();
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    assistant,
    started,
    stopped,
    close: async () => {
      assistant.stop();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const turn = async (r: Rig, callId: string, event: string, text?: string) =>
  (await fetch(`${r.url}/connect/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId, event, text }) })).json();

function assign(r: Rig, person = "Maya") {
  const c = r.store.contact(r.store.contacts.find((x) => x.name === person)!.id)!;
  return r.assistant.startTask({ kind: "task", contact: c, details: "bring the visitor badges to reception" });
}

test("a contact on the Connect line gets a real outbound call with the call id attached", async () => {
  rig = await start();
  const t = assign(rig);
  await until(() => rig!.started.length === 1);
  assert.equal(rig.started[0].destination, "+12065550123");
  assert.equal(rig.started[0].attributes.callId, t.callIds[0]);
  assert.equal(rig.started[0].attributes.purpose, "assign");
});

test("local-demo contacts still ring the local phones, not Connect", async () => {
  rig = await start();
  assign(rig, "Raju");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rig.started.length, 0);
});

test("a full conversation through the contact flow's turns", async () => {
  rig = await start();
  const t = assign(rig);
  const callId = t.callIds[0];
  const hello = await turn(rig, callId, "answered");
  assert.match(hello.say, /Madhu's AI assistant at Mobil80\. Just a quick one, and you can say stop anytime\./);
  assert.match(hello.say, /bring the visitor badges to reception/);
  assert.equal(hello.end, false);
  const when = await turn(rig, callId, "heard", "Sure, I can do that");
  assert.match(when.say, /Roughly when do you think it'll be done/);
  assert.equal(when.end, false);
  const bye = await turn(rig, callId, "heard", "in ten minutes");
  assert.match(bye.say, /Perfect, in 10 minutes/);
  assert.match(bye.say, /To reach CallAssist, call/);
  assert.equal(bye.end, true);
  assert.equal(rig.store.tasks.get(t.id)!.status, "accepted");
  assert.equal(rig.store.tasks.get(t.id)!.eta, "in 10 minutes");
  assert.equal(rig.stopped.length, 0, "the flow hangs up itself after the last line");
});

test("silence on a turn re-asks instead of failing", async () => {
  rig = await start();
  const t = assign(rig);
  await turn(rig, t.callIds[0], "answered");
  const r = await turn(rig, t.callIds[0], "heard", "");
  assert.match(r.say, /didn't catch that/);
  assert.equal(r.end, false);
});

test("'stop' on a real call opts them out and ends the call", async () => {
  rig = await start();
  const t = assign(rig);
  await turn(rig, t.callIds[0], "answered");
  const r = await turn(rig, t.callIds[0], "heard", "stop calling me");
  assert.equal(r.end, true);
  assert.equal(rig.store.contact("c_maya")!.optedOut, true);
});

test("hang-up from the flow is handled like a hang-up on the local phones", async () => {
  rig = await start();
  const t = assign(rig);
  await turn(rig, t.callIds[0], "answered");
  const r = await turn(rig, t.callIds[0], "hangup");
  assert.equal(r.end, true);
  await until(() => rig!.store.tasks.get(t.id)!.nextActionAt, 2000, "retry scheduled");
});

test("no answer: CallAssist stops the Connect contact and retries later", async () => {
  rig = await start({ ringTimeoutMs: 150 });
  const t = assign(rig);
  await until(() => rig!.stopped.length >= 1, 2000, "stop contact");
  assert.equal(rig.stopped[0], "contact-1");
  await until(() => rig!.started.length >= 2, 3000, "retry");
  assert.equal(rig.store.tasks.get(t.id)!.attempts >= 2, true);
});

test("if Connect refuses the call, the task retries and then reports it", async () => {
  rig = await start({ failStart: true });
  const t = assign(rig);
  await until(() => rig!.store.tasks.get(t.id)!.status === "unreachable", 4000, "unreachable");
});

test("turns for unknown calls end politely; bad input is refused", async () => {
  rig = await start();
  const r = await turn(rig, "nope", "answered");
  assert.equal(r.end, true);
  const bad = await fetch(`${rig.url}/connect/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: "x", event: "explode" }) });
  assert.equal(bad.status, 400);
});

test("real volunteer numbers can live in a git-ignored override file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ca-"));
  const seedFile = join(dir, "seed.json");
  const extra = join(dir, "contacts.json");
  writeFileSync(seedFile, JSON.stringify(SEED));
  writeFileSync(extra, JSON.stringify([{ id: "c_raju", phone: "+12065550199", line: "connect" }, { id: "c_new", name: "Priya", label: "volunteer", phone: "+12065550100", consent: true, line: "connect" }]));
  const s = Store.fromFile(seedFile, undefined, extra);
  assert.equal(s.contact("c_raju")!.phone, "+12065550199");
  assert.equal(s.contact("c_raju")!.line, "connect");
  assert.equal(s.contact("c_raju")!.name, "Raju", "other fields kept");
  assert.equal(s.contact("c_new")!.optedOut, false);
});

// ---------------------------------------------------------------- browser calling (WebRTC)
import { ConnectWebCallTelephony } from "../src/connect.js";
import type { PhoneSignal } from "../src/telephony.js";

async function startWeb() {
  const store = new Store(structuredClone(SEED));
  const webStarts: { displayName: string; attributes: Record<string, string> }[] = [];
  const stopped: string[] = [];
  const api: ConnectApi = {
    async startCall() { throw new Error("no numbers"); },
    async stopCall(id) { stopped.push(id); },
    async startWebCall(input) { webStarts.push(input); return { contactId: "web-contact-1", connectionData: { Meeting: { MeetingId: "m1" }, Attendee: { AttendeeId: "a1", JoinToken: "t" } } }; },
  };
  const local = new LocalPhoneNetwork();
  const web = new ConnectWebCallTelephony(api, local);
  const router = new TelephonyRouter({ local, "connect-web": web }, () => "connect-web");
  const assistant = new Assistant(store, router, { ...FAST, ringTimeoutMs: 3000 });
  const app = createApp({ assistant, phone: local, webCalls: web, publicDir: join(root, "public"), rateLimits: { mcp: 0, token: 0, alexa: 0 } });
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  assistant.start();
  const signals: PhoneSignal[] = [];
  local.listen("c_raju", (s) => signals.push(s));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, store, assistant, webStarts, stopped, signals,
    close: async () => { assistant.stop(); server.closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

test("browser call: the phone page rings with a Connect flag, no PSTN call is placed", async () => {
  const w = await startWeb();
  rig = { ...w, started: [], close: w.close } as any;
  const t = w.assistant.startTask({ kind: "task", contact: w.store.contact("c_raju")!, details: "bring the visitor badges" });
  await until(() => w.signals.some((s) => s.type === "incoming"));
  const ring = w.signals.find((s) => s.type === "incoming") as any;
  assert.equal(ring.via, "connect-web");
  assert.equal(ring.callId, t.callIds[0]);
  assert.equal(w.webStarts.length, 0, "nothing starts until the worker accepts");
});

test("browser call: accept starts a Connect WebRTC contact; turns flow with live captions", async () => {
  const w = await startWeb();
  rig = { ...w, started: [], close: w.close } as any;
  const t = w.assistant.startTask({ kind: "task", contact: w.store.contact("c_raju")!, details: "bring the visitor badges" });
  const callId = t.callIds[0];
  const acc = await (await fetch(`${w.url}/api/phone/calls/${callId}/webrtc`, { method: "POST" })).json();
  assert.equal(acc.connectionData.Meeting.MeetingId, "m1");
  assert.equal(w.webStarts[0].attributes.callId, callId, "the Connect flow knows which CallAssist call this is");
  assert.equal(w.webStarts[0].displayName, "Raju");
  const hello = await turn(w as any, callId, "answered");
  assert.match(hello.say, /Madhu's AI assistant/);
  assert.ok(w.signals.some((s) => s.type === "caption" && s.who === "assistant" && /AI assistant/.test(s.text)), "captions reach the page");
  await turn(w as any, callId, "heard", "okay");
  const bye = await turn(w as any, callId, "heard", "in five minutes");
  assert.equal(bye.end, true);
  assert.ok(w.signals.some((s) => s.type === "caption" && s.who === "contact" && s.text === "in five minutes"));
  assert.equal(w.store.tasks.get(t.id)!.eta, "in 5 minutes");
});

test("browser call: declining on the page ends it without touching Connect", async () => {
  const w = await startWeb();
  rig = { ...w, started: [], close: w.close } as any;
  const t = w.assistant.startTask({ kind: "task", contact: w.store.contact("c_raju")!, details: "check the printer" });
  await fetch(`${w.url}/api/phone/calls/${t.callIds[0]}/reject`, { method: "POST" });
  await until(() => w.store.tasks.get(t.id)!.nextActionAt, 2000, "retry scheduled");
  assert.equal(w.webStarts.length, 0);
});

test("browser call: hanging up on the page also ends the Connect contact", async () => {
  const w = await startWeb();
  rig = { ...w, started: [], close: w.close } as any;
  const t = w.assistant.startTask({ kind: "task", contact: w.store.contact("c_raju")!, details: "check the printer" });
  const callId = t.callIds[0];
  await fetch(`${w.url}/api/phone/calls/${callId}/webrtc`, { method: "POST" });
  await turn(w as any, callId, "answered");
  await fetch(`${w.url}/api/phone/calls/${callId}/reject`, { method: "POST" });
  assert.deepEqual(w.stopped, ["web-contact-1"]);
});
