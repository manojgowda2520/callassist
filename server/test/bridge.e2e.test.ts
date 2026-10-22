// End-to-end: the real sip-bridge program against a fake Asterisk (ARI) and a
// real CallAssist server with OAuth on. Proves the bridge dials, speaks,
// records, transcribes, and finishes the conversation before it touches a PBX.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Assistant } from "../src/assistant.js";
import { createApp } from "../src/app.js";
import { AuthServer } from "../src/auth.js";
import { Store } from "../src/store.js";
import { LocalPhoneNetwork } from "../src/telephony.js";
import { TelephonyRouter } from "../src/connect.js";
import { SipBroker, SipTelephony } from "../src/sip.js";
import { pcmToWav, type PhoneSpeech } from "../src/speech.js";
import { FAST, SEED, until } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, "../../sip-bridge/bridge.mjs");

let ca: Server, ariServer: Server, bridge: ChildProcess, assistant: Assistant, store: Store, sip: SipTelephony;
const ari = { calls: [] as string[], plays: 0, records: 0, deletes: 0, sockets: new Set<WebSocket>() };
let recordingsDir = "";
let bridgeLog = "";

before(async () => {
  // ---- CallAssist with OAuth and the SIP line
  const seed = structuredClone(SEED);
  seed.contacts.push({ id: "c_test", name: "Manoj Mobile", label: "test phone", aliases: [], phone: "+919800000000", consent: true, optedOut: false, line: "sip", consentRecord: { at: "2026-10-22T00:00:00Z", method: "written", wording: "AI-voice calls ok" } });
  store = new Store(seed);
  const local = new LocalPhoneNetwork();
  sip = new SipTelephony(new SipBroker());
  assistant = new Assistant(store, new TelephonyRouter({ local, sip }, (c) => store.contact(c.contactId)?.line ?? "local"), { ...FAST, ringTimeoutMs: 8000, silenceTimeoutMs: 8000 });
  let heard = 0;
  const speech: PhoneSpeech = {
    wav8k: async () => pcmToWav(Buffer.alloc(800)),
    transcribe: async () => (++heard === 1 ? "yes, ten minutes" : "okay"),
  };
  ca = createServer();
  ca.listen(0, "127.0.0.1");
  await once(ca, "listening");
  const base = `http://127.0.0.1:${(ca.address() as AddressInfo).port}`;
  const auth = new AuthServer({ issuer: base, resource: `${base}/mcp`, agentResource: `${base}/agent/mcp`, secret: "s", userId: "u", userName: "Manoj", clients: [{ clientId: "sip-bridge", clientSecret: "bridge-secret", name: "bridge", redirectUris: [], serviceScopes: ["agent:calls"] }] });
  ca.on("request", createApp({ assistant, phone: local, sip, phoneSpeech: speech, auth, publicDir: join(here, "../public"), rateLimits: { mcp: 0, token: 0, alexa: 0 } }));
  assistant.start();

  // ---- fake Asterisk ARI
  recordingsDir = mkdtempSync(join(tmpdir(), "ca-rec-"));
  const sounds = mkdtempSync(join(tmpdir(), "ca-snd-"));
  ariServer = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    const emit = (ev: object, ms = 20) => setTimeout(() => ari.sockets.forEach((s) => s.send(JSON.stringify(ev))), ms);
    const json = (b: object) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(b)));
    if (req.headers.authorization !== "Basic " + Buffer.from("callassist:ari-pass").toString("base64")) return void (res.writeHead(401), res.end());
    let m: RegExpMatchArray | null;
    if (req.method === "POST" && u.pathname === "/ari/channels") {
      ari.calls.push(u.searchParams.get("endpoint")!);
      const id = `ch${ari.calls.length}`;
      emit({ type: "StasisStart", channel: { id }, args: [u.searchParams.get("appArgs")] }, 60);
      return json({ id });
    }
    if (req.method === "POST" && (m = u.pathname.match(/^\/ari\/channels\/([^/]+)\/play$/))) {
      ari.plays++;
      const id = `pb${ari.plays}`;
      emit({ type: "PlaybackFinished", playback: { id } });
      return json({ id });
    }
    if (req.method === "POST" && (m = u.pathname.match(/^\/ari\/channels\/([^/]+)\/record$/))) {
      ari.records++;
      const name = u.searchParams.get("name")!;
      writeFileSync(join(recordingsDir, `${name}.wav`), pcmToWav(Buffer.alloc(16000)));
      emit({ type: "RecordingFinished", recording: { name } }, 40);
      return json({ name });
    }
    if (req.method === "DELETE" && (m = u.pathname.match(/^\/ari\/channels\/([^/]+)$/))) {
      ari.deletes++;
      emit({ type: "ChannelDestroyed", channel: { id: m[1] }, cause_txt: "Normal Clearing" });
      res.writeHead(204);
      return void res.end();
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  ariServer.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => (ari.sockets.add(ws), ws.on("close", () => ari.sockets.delete(ws)))));
  ariServer.listen(0, "127.0.0.1");
  await once(ariServer, "listening");

  // ---- the real bridge program
  bridge = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      CALLASSIST_URL: base,
      BRIDGE_CLIENT_SECRET: "bridge-secret",
      ARI_URL: `http://127.0.0.1:${(ariServer.address() as AddressInfo).port}`,
      ARI_USER: "callassist",
      ARI_PASS: "ari-pass",
      SOUNDS_DIR: sounds,
      RECORDING_DIR: recordingsDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout!.on("data", (d) => (bridgeLog += d));
  bridge.stderr!.on("data", (d) => (bridgeLog += d));
  await until(() => sip.broker.connected === 1 && ari.sockets.size === 1, 8000, "bridge connected to CallAssist and ARI");
});

after(async () => {
  bridge?.kill();
  assistant?.stop();
  ari.sockets.forEach((s) => s.terminate());
  ca?.closeAllConnections?.();
  ariServer?.closeAllConnections?.();
  await Promise.all([new Promise((r) => ca.close(r)), new Promise((r) => ariServer.close(r))]);
});

test("the bridge dials through the test context, talks, listens and finishes the call", async () => {
  const t = assistant.startTask({ kind: "task", contact: store.contact("c_test")!, details: "bring the visitor badges" });
  await until(() => store.tasks.get(t.id)!.status === "accepted", 10000, `accepted (bridge log: ${bridgeLog.slice(-600)})`);
  assert.deepEqual(ari.calls, ["Local/+919800000000@callassist-test"], "dials only via the allowlist context");
  assert.equal(store.tasks.get(t.id)!.eta, "in 10 minutes");
  await until(() => ari.deletes === 1, 5000, "hung up after the goodbye");
  assert.ok(ari.plays >= 2, "spoke the script and the goodbye");
  assert.equal(ari.records, 1, "listened once");
  assert.equal(readdirSync(recordingsDir).length, 0, "the reply recording was deleted after transcribing");
  const call = store.calls.get(t.callIds[0])!;
  assert.ok(call.transcript.some((l) => l.who === "contact" && l.text === "yes, ten minutes"));
  assert.ok(!/\+919800000000/.test(bridgeLog), "the bridge log masks phone numbers");
  assert.ok(existsSync(bridgePath));
});
