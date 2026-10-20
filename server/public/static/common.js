// Shared browser helpers for the CallAssist local demo pages.
export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  if (!res.ok) throw Object.assign(new Error((data && (data.error || data.speech)) || res.statusText), { data, status: res.status });
  return data;
}

/** Subscribe to a server-sent event stream; reconnects by itself. */
export function stream(path, handlers) {
  let es;
  const open = () => {
    es = new EventSource(path);
    for (const [name, fn] of Object.entries(handlers)) es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
    es.onerror = () => {
      handlers.status?.(false);
    };
    es.onopen = () => handlers.status?.(true);
  };
  open();
  return () => es && es.close();
}

/** Plays audio clips one after another; falls back to the browser voice. */
export class AudioQueue {
  constructor({ voiceName, rate = 1 } = {}) {
    this.q = [];
    this.playing = false;
    this.voiceName = voiceName;
    this.rate = rate;
    this.audio = new Audio();
    this.onIdle = null;
    this.onStart = null;
  }
  push(text, url) {
    this.q.push({ text, url });
    if (!this.playing) this.next();
  }
  clear() {
    this.q = [];
    try {
      this.audio.pause();
    } catch {}
    window.speechSynthesis?.cancel();
    this.playing = false;
  }
  get busy() {
    return this.playing || this.q.length > 0;
  }
  async next() {
    const item = this.q.shift();
    if (!item) {
      this.playing = false;
      this.onIdle?.();
      return;
    }
    this.playing = true;
    this.onStart?.(item.text);
    const done = () => this.next();
    if (item.url) {
      this.audio.src = item.url;
      this.audio.onended = done;
      this.audio.onerror = () => this.speakFallback(item.text, done);
      try {
        await this.audio.play();
        return;
      } catch {
        // autoplay blocked or failed: use the browser voice
      }
    }
    this.speakFallback(item.text, done);
  }
  speakFallback(text, done) {
    const synth = window.speechSynthesis;
    if (!synth) return setTimeout(done, Math.min(4000, 60 * text.length));
    const u = new SpeechSynthesisUtterance(text);
    u.rate = this.rate;
    const v = synth.getVoices().find((x) => x.name.startsWith(this.voiceName || "Samantha"));
    if (v) u.voice = v;
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  }
}

/** A phone ringtone made with Web Audio (no files). */
export class Ringtone {
  constructor() {
    this.ctx = null;
    this.timer = null;
  }
  unlock() {
    this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
  }
  start() {
    this.unlock();
    this.stop();
    const ring = () => {
      const t = this.ctx.currentTime;
      for (const [offset, f] of [[0, 440], [0, 480], [0.45, 440], [0.45, 480]]) {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + offset);
        g.gain.exponentialRampToValueAtTime(0.08, t + offset + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.38);
        o.connect(g).connect(this.ctx.destination);
        o.start(t + offset);
        o.stop(t + offset + 0.4);
      }
    };
    ring();
    this.timer = setInterval(ring, 2500);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  chime() {
    this.unlock();
    const t = this.ctx.currentTime;
    [[0, 660], [0.14, 880]].forEach(([d, f]) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.12, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5);
      o.connect(g).connect(this.ctx.destination);
      o.start(t + d);
      o.stop(t + d + 0.55);
    });
  }
}

/** Speech-to-text with the browser's recognizer, when it has one. */
export class Listener {
  constructor(onText, onState) {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!R;
    this.onText = onText;
    this.onState = onState;
    if (!R) return;
    this.r = new R();
    this.r.lang = "en-US";
    this.r.interimResults = true;
    this.r.maxAlternatives = 1;
    this.r.onresult = (e) => {
      let final = "";
      let interim = "";
      for (const res of e.results) (res.isFinal ? (final += res[0].transcript) : (interim += res[0].transcript));
      this.onState?.("interim", interim || final);
      if (final) this.onText(final.trim());
    };
    this.r.onend = () => this.onState?.("idle");
    this.r.onerror = (e) => this.onState?.("error", e.error);
  }
  start() {
    if (!this.r) return false;
    try {
      this.r.start();
      this.onState?.("listening");
      return true;
    } catch {
      return false;
    }
  }
  stop() {
    try {
      this.r?.stop();
    } catch {}
  }
}

export const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
};

export const timeAgo = (iso) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

export const STATUS = {
  calling: { label: "Calling", tone: "blue" },
  accepted: { label: "On it", tone: "green" },
  blocked: { label: "Needs you", tone: "amber" },
  done: { label: "Done", tone: "teal" },
  declined: { label: "Declined", tone: "red" },
  unreachable: { label: "No answer", tone: "red" },
  cancelled: { label: "Cancelled", tone: "gray" },
};
