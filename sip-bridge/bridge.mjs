#!/usr/bin/env node
// CallAssist SIP bridge. Runs next to Asterisk and connects OUT to CallAssist.
//
//   CallAssist ──/sip/events (job: call +91…)──► bridge ──ARI──► Asterisk ──Airtel──► phone
//   CallAssist ◄──/sip/turn, /sip/stt, /sip/tts── bridge  (speak, record, transcribe, repeat)
//
// No AWS keys here: CallAssist makes the voice (Polly) and reads replies
// (Transcribe). Asterisk only dials through the callassist-test context, which
// allows the consenting test numbers and nothing else.
//
// Needs Node 22+ (built-in WebSocket and fetch). Config: environment variables,
// see bridge.env.example.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cfg = {
  url: must("CALLASSIST_URL").replace(/\/$/, ""),
  clientId: process.env.BRIDGE_CLIENT_ID ?? "sip-bridge",
  clientSecret: must("BRIDGE_CLIENT_SECRET"),
  ari: (process.env.ARI_URL ?? "http://127.0.0.1:8088").replace(/\/$/, ""),
  ariUser: must("ARI_USER"),
  ariPass: must("ARI_PASS"),
  app: process.env.ARI_APP ?? "callassist",
  context: process.env.DIAL_CONTEXT ?? "callassist-test",
  sounds: process.env.SOUNDS_DIR ?? "/var/lib/asterisk/sounds/callassist",
  recordings: process.env.RECORDING_DIR ?? "/var/spool/asterisk/recording",
  callerId: process.env.CALLER_ID ?? "CallAssist",
  maxSilence: Number(process.env.MAX_SILENCE_SECONDS ?? 2),
  maxReply: Number(process.env.MAX_REPLY_SECONDS ?? 15),
};

function must(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. See bridge.env.example.`);
    process.exit(2);
  }
  return v;
}

const log = (event, extra = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...extra }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(cfg.sounds, { recursive: true });

// ---------------------------------------------------------------- CallAssist API (OAuth client_credentials)
let token = null;
let tokenExp = 0;
async function getToken(force = false) {
  if (!force && token && Date.now() < tokenExp - 60_000) return token;
  const basic = Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString("base64");
  const res = await fetch(`${cfg.url}/oauth/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "agent:calls", resource: `${cfg.url}/agent/mcp` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token: ${res.status} ${body.error ?? ""}`);
  token = body.access_token;
  tokenExp = Date.now() + body.expires_in * 1000;
  return token;
}

async function ca(path, init = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${cfg.url}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await getToken(attempt > 0)}` } });
    if (res.status !== 401) return res;
  }
  throw new Error(`${path}: unauthorized`);
}

async function turn(callId, event, text = "") {
  const res = await ca("/sip/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId, event, text }) });
  return res.json();
}

// ---------------------------------------------------------------- Asterisk ARI
const ariAuth = "Basic " + Buffer.from(`${cfg.ariUser}:${cfg.ariPass}`).toString("base64");
async function ari(method, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${cfg.ari}/ari${path}${qs ? `?${qs}` : ""}`, { method, headers: { authorization: ariAuth } });
  if (!res.ok && res.status !== 404) throw new Error(`ARI ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 || res.status === 404 ? null : res.json();
}

const waiters = new Set();
function waitFor(match, ms) {
  return new Promise((resolve) => {
    const w = { match, resolve, timer: setTimeout(() => (waiters.delete(w), resolve(null)), ms) };
    waiters.add(w);
  });
}

const calls = new Map(); // channelId -> { callId, live, answered }
const byCallId = new Map(); // callId -> channelId

function connectAriEvents() {
  const u = `${cfg.ari.replace(/^http/, "ws")}/ari/events?app=${encodeURIComponent(cfg.app)}&api_key=${encodeURIComponent(`${cfg.ariUser}:${cfg.ariPass}`)}`;
  const ws = new WebSocket(u);
  ws.onopen = () => log("ari_connected");
  ws.onclose = () => {
    log("ari_disconnected");
    setTimeout(connectAriEvents, 3000);
  };
  ws.onerror = () => {};
  ws.onmessage = (m) => {
    let ev;
    try {
      ev = JSON.parse(String(m.data));
    } catch {
      return;
    }
    for (const w of [...waiters]) if (w.match(ev)) (clearTimeout(w.timer), waiters.delete(w), w.resolve(ev));
    onAriEvent(ev).catch((e) => log("ari_event_error", { error: String(e) }));
  };
}

async function onAriEvent(ev) {
  const chanId = ev.channel?.id;
  const call = chanId && calls.get(chanId);
  if (ev.type === "StasisStart" && call && !call.answered) {
    call.answered = true;
    log("answered", { callId: call.callId });
    runConversation(chanId, call).catch((e) => log("conversation_error", { callId: call.callId, error: String(e) }));
  }
  if ((ev.type === "ChannelDestroyed" || ev.type === "StasisEnd") && call && call.live) {
    call.live = false;
    calls.delete(chanId);
    byCallId.delete(call.callId);
    log("ended", { callId: call.callId, cause: ev.cause_txt ?? ev.type });
    if (!call.endedByUs) await turn(call.callId, "hangup").catch(() => {});
  }
}

// ---------------------------------------------------------------- one call
async function placeCall(job) {
  if (byCallId.has(job.callId)) return;
  try {
    const ch = await ari("POST", "/channels", {
      endpoint: `Local/${job.phone}@${cfg.context}`,
      app: cfg.app,
      appArgs: job.callId,
      timeout: "45",
      callerId: cfg.callerId,
    });
    calls.set(ch.id, { callId: job.callId, live: true, answered: false, endedByUs: false });
    byCallId.set(job.callId, ch.id);
    log("dialing", { callId: job.callId, to: job.phone.replace(/\d(?=\d{4})/g, "•") });
  } catch (e) {
    log("dial_failed", { callId: job.callId, error: String(e) });
    await turn(job.callId, "hangup").catch(() => {});
  }
}

async function hangUp(chanId, call) {
  if (!call.live) return;
  call.endedByUs = true;
  await ari("DELETE", `/channels/${chanId}`).catch(() => {});
}

async function speak(chanId, call, text) {
  if (!text || !call.live) return;
  const file = createHash("sha1").update(text).digest("hex").slice(0, 20);
  const path = join(cfg.sounds, `${file}.wav`);
  if (!existsSync(path)) {
    const res = await ca(`/sip/tts?text=${encodeURIComponent(text)}`);
    if (!res.ok) throw new Error(`tts ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const pb = await ari("POST", `/channels/${chanId}/play`, { media: `sound:callassist/${file}` });
  if (!pb) return;
  await waitFor((e) => (e.type === "PlaybackFinished" && e.playback?.id === pb.id) || (e.type === "ChannelDestroyed" && e.channel?.id === chanId), 60_000);
}

async function listen(chanId, call, n) {
  if (!call.live) return "";
  const name = `callassist-${call.callId.slice(0, 8)}-${n}`;
  await ari("POST", `/channels/${chanId}/record`, {
    name,
    format: "wav",
    maxDurationSeconds: String(cfg.maxReply),
    maxSilenceSeconds: String(cfg.maxSilence),
    ifExists: "overwrite",
    beep: "false",
    terminateOn: "none",
  });
  await waitFor(
    (e) => ((e.type === "RecordingFinished" || e.type === "RecordingFailed") && e.recording?.name === name) || (e.type === "ChannelDestroyed" && e.channel?.id === chanId),
    (cfg.maxReply + 5) * 1000,
  );
  const path = join(cfg.recordings, `${name}.wav`);
  if (!existsSync(path)) return "";
  const audio = readFileSync(path);
  // Replies are only kept long enough to transcribe them.
  try {
    unlinkSync(path);
  } catch {}
  const res = await ca("/sip/stt", { method: "POST", headers: { "content-type": "audio/wav" }, body: audio });
  const { text } = await res.json().catch(() => ({ text: "" }));
  log("heard", { callId: call.callId, chars: (text ?? "").length });
  return text ?? "";
}

async function runConversation(chanId, call) {
  let r = await turn(call.callId, "answered");
  for (let n = 1; call.live && n <= 12; n++) {
    await speak(chanId, call, r.say);
    if (r.end) {
      await sleep(600);
      await hangUp(chanId, call);
      return;
    }
    const text = await listen(chanId, call, n);
    if (!call.live) return;
    r = await turn(call.callId, "heard", text);
  }
  await hangUp(chanId, call);
}

// ---------------------------------------------------------------- jobs from CallAssist (SSE)
async function listenForJobs() {
  for (;;) {
    try {
      const res = await ca("/sip/events", { headers: { accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      log("callassist_connected", { url: cfg.url });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data:"));
          if (!data) continue;
          const job = JSON.parse(data.slice(5));
          if (job.type === "call") placeCall(job);
          else if (job.type === "hangup") {
            const chanId = byCallId.get(job.callId);
            const call = chanId && calls.get(chanId);
            if (call) hangUp(chanId, call);
          }
        }
      }
      log("callassist_disconnected");
    } catch (e) {
      log("callassist_error", { error: String(e) });
    }
    await sleep(3000);
  }
}

log("starting", { callassist: cfg.url, ari: cfg.ari, context: cfg.context });
connectAriEvents();
listenForJobs();
