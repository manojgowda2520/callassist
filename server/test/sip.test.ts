// SIP line (Asterisk + Airtel) with a fake bridge: jobs out on the broker,
// turns back on /sip/turn, speech through a fake PhoneSpeech.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Assistant } from "../src/assistant.js";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { LocalPhoneNetwork } from "../src/telephony.js";
import { TelephonyRouter } from "../src/connect.js";
import { SipBroker, SipTelephony, type BridgeJob } from "../src/sip.js";
import { pcmToWav, trimSilence, wavToPcm, type PhoneSpeech } from "../src/speech.js";
import { FAST, SEED, until } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(withBridge = true) {
  const seed = structuredClone(SEED);
  seed.contacts.push({ id: "c_test", name: "Manoj Mobile", label: "test phone", aliases: [], phone: "+919800000000", consent: true, optedOut: false, line: "sip", timezone: "Asia/Kolkata", consentRecord: { at: "2026-10-22T00:00:00Z", method: "written", wording: "AI-voice calls ok" } });
  const store = new Store(seed);
  const local = new LocalPhoneNetwork();
  const broker = new SipBroker();
  const sip = new SipTelephony(broker);
  const router = new TelephonyRouter({ local, sip }, (call) => store.contact(call.contactId)?.line ?? "local");
  const assistant = new Assistant(store, router, { ...FAST, ringTimeoutMs: 3000 });
  const spoken: string[] = [];
  const speech: PhoneSpeech = {
    async wav8k(text) {
      spoken.push(text);
      return pcmToWav(Buffer.alloc(1600));
    },
    async transcribe(audio) {
      return wavToPcm(audio).length > 1600 ? "yes, ten minutes" : "";
    },
  };
  const app = createApp({ assistant, phone: local, sip, phoneSpeech: speech, publicDir: join(root, "public"), rateLimits: { mcp: 0, token: 0, alexa: 0 } });
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  assistant.start();
  const jobs: BridgeJob[] = [];
  if (withBridge) broker.subscribe((j) => jobs.push(j));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    assistant.stop();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  };
  const task = () => assistant.startTask({ kind: "task", contact: store.contact("c_test")!, details: "bring the visitor badges" });
  const turn = async (callId: string, event: string, text?: string) =>
    (await fetch(`${url}/sip/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId, event, text }) })).json();
  return { url, store, assistant, jobs, spoken, task, turn, broker };
}

test("a contact on the SIP line becomes a call job for the bridge", async () => {
  const r = await start();
  const t = r.task();
  await until(() => r.jobs.length === 1);
  assert.deepEqual(r.jobs[0], { type: "call", callId: t.callIds[0], phone: "+919800000000", purpose: "assign" });
});

test("a full call over SIP turns, same engine as every other line", async () => {
  const r = await start();
  const t = r.task();
  const callId = t.callIds[0];
  const hello = await r.turn(callId, "answered");
  assert.match(hello.say, /Manoj's AI assistant/);
  await r.turn(callId, "heard", "okay");
  const bye = await r.turn(callId, "heard", "in ten minutes");
  assert.equal(bye.end, true);
  assert.equal(r.store.tasks.get(t.id)!.eta, "in 10 minutes");
});

test("with no bridge connected the call fails and is retried, not lost", async () => {
  const r = await start(false);
  const t = r.task();
  await until(() => r.store.tasks.get(t.id)!.nextActionAt || r.store.tasks.get(t.id)!.status === "unreachable", 3000, "retry or unreachable");
});

test("cancelling sends a hangup job to the bridge", async () => {
  const r = await start();
  const t = r.task();
  await until(() => r.jobs.length === 1);
  r.assistant.cancelTask(t.id, false);
  await until(() => r.jobs.some((j) => j.type === "hangup" && j.callId === t.callIds[0]));
});

test("the bridge gets 8 kHz WAV audio and transcripts from the server", async () => {
  const r = await start();
  const audio = await fetch(`${r.url}/sip/tts?text=${encodeURIComponent("Hello Raju")}`);
  assert.equal(audio.headers.get("content-type"), "audio/wav");
  const wav = Buffer.from(await audio.arrayBuffer());
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 8000, "8 kHz for the telephone network");
  assert.deepEqual(r.spoken, ["Hello Raju"]);
  const stt = await (await fetch(`${r.url}/sip/stt`, { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(pcmToWav(Buffer.alloc(16000))) })).json();
  assert.equal(stt.text, "yes, ten minutes");
  const empty = await (await fetch(`${r.url}/sip/stt`, { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(pcmToWav(Buffer.alloc(10))) })).json();
  assert.equal(empty.text, "");
});

test("WAV helpers round-trip and survive non-WAV input", () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(wavToPcm(pcmToWav(pcm)), pcm);
  assert.deepEqual(wavToPcm(pcm), pcm);
});

test("silence around a reply is cut before transcribing; pure silence is dropped", () => {
  // 1 s of line hiss, 0.5 s of "speech", 2 s of hiss: what Asterisk records before its silence timeout.
  const samples = (seconds: number, amp: number) => {
    const b = Buffer.alloc(seconds * 8000 * 2);
    for (let i = 0; i < b.length; i += 2) b.writeInt16LE(Math.round(Math.sin(i / 7) * amp), i);
    return b;
  };
  const reply = Buffer.concat([samples(1, 60), samples(0.5, 6000), samples(2, 60)]);
  const cut = trimSilence(reply);
  const seconds = cut.length / 16000;
  assert.ok(seconds >= 0.5 && seconds <= 1.1, `kept ${seconds}s`);
  assert.equal(trimSilence(samples(3, 60)).length, 0, "only hiss: nothing to transcribe");
  assert.equal(trimSilence(Buffer.alloc(0)).length, 0);
});

test("sounds like a person: first name, plain ask, no callback number on the SIP line", async () => {
  const r = await start();
  const t = r.task();
  const callId = t.callIds[0];
  const hello = await r.turn(callId, "answered");
  assert.match(hello.say, /^Hi Manoj! /, "greets by first name, not 'Manoj Mobile'");
  assert.match(hello.say, /wondering if you could bring the visitor badges/);
  await r.turn(callId, "heard", "okay");
  const bye = await r.turn(callId, "heard", "in ten minutes");
  assert.ok(!/To reach CallAssist|\+1 555/.test(bye.say), "the SIP number takes no calls, so no callback number is read out");
});

test("silence: the last question is asked again once, then the conversation decides", async () => {
  const r = await start();
  const t = r.task();
  const callId = t.callIds[0];
  await r.turn(callId, "answered");
  const again = await r.turn(callId, "heard", "");
  assert.equal(again.say, "Sorry, I didn't catch that. Would you be able to do that?");
  const yes = await r.turn(callId, "heard", "yes");
  assert.match(yes.say, /Roughly when/);
  const again2 = await r.turn(callId, "heard", "");
  assert.match(again2.say, /^Sorry, I didn't catch that\. Roughly when do you think it'll be done\?$/, "repeats the question that was actually asked");
  const after = await r.turn(callId, "heard", "");
  assert.equal(after.end, true, "a second silence in a row ends the call politely");
  assert.equal(r.store.tasks.get(t.id)!.status, "accepted", "the earlier yes is kept");
});
