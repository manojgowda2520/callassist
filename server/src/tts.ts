// Text-to-speech for the Alexa+ emulator and the phones.
// On AWS: Amazon Polly generative voices, the closest to the Alexa+ voice
// (Danielle for Alexa and for CallAssist on the phone). On a Mac
// without AWS: the built-in `say` voices. Clips are cached by text.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from "@aws-sdk/client-polly";

const run = promisify(execFile);

export type VoiceRole = "alexa" | "agent";

export interface Tts {
  readonly engine: string;
  readonly available: boolean;
  /** Path of an mp3 for this text, made on first use. */
  file(text: string, role: VoiceRole): Promise<string>;
}

const clean = (text: string) => text.replace(/[\u0000-\u001f]+/g, " ").slice(0, 600);
const key = (engine: string, voice: string, text: string) => createHash("sha1").update(`${engine}\n${voice}\n${text}`).digest("hex").slice(0, 24);

/** Shared caching: one synthesis per distinct clip, even with concurrent requests. */
abstract class CachedTts implements Tts {
  abstract readonly engine: string;
  abstract readonly available: boolean;
  private inflight = new Map<string, Promise<string>>();

  constructor(protected dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  protected abstract voiceFor(role: VoiceRole): string;
  protected abstract synthesize(text: string, voice: string, mp3: string): Promise<void>;

  async file(text: string, role: VoiceRole): Promise<string> {
    const t = clean(text);
    const voice = this.voiceFor(role);
    const k = key(this.engine, voice, t);
    const mp3 = join(this.dir, `${k}.mp3`);
    if (existsSync(mp3)) return mp3;
    const busy = this.inflight.get(k);
    if (busy) return busy;
    const job = this.synthesize(t, voice, mp3)
      .then(() => mp3)
      .finally(() => this.inflight.delete(k));
    this.inflight.set(k, job);
    return job;
  }
}

/** Amazon Polly, generative engine. */
export class PollyTts extends CachedTts {
  readonly engine = "amazon-polly";
  readonly available = true;
  private client: PollyClient;

  constructor(dir: string, private voices: Record<VoiceRole, VoiceId> = { alexa: "Danielle", agent: "Danielle" }, region = process.env.AWS_REGION ?? "us-east-1") {
    super(dir);
    this.client = new PollyClient({ region });
  }

  protected voiceFor(role: VoiceRole): string {
    return this.voices[role];
  }

  protected async synthesize(text: string, voice: string, mp3: string): Promise<void> {
    const out = await this.client.send(new SynthesizeSpeechCommand({ Engine: "generative", VoiceId: voice as VoiceId, OutputFormat: "mp3", Text: text, TextType: "text" }));
    if (!out.AudioStream) throw new Error("Polly returned no audio");
    writeFileSync(mp3, await out.AudioStream.transformToByteArray());
  }
}

/** macOS `say` + ffmpeg, for working offline on a Mac. */
export class LocalTts extends CachedTts {
  readonly engine = "macos-say";
  readonly available = process.platform === "darwin";

  constructor(dir: string, private ffmpeg = "ffmpeg") {
    super(dir);
  }

  protected voiceFor(role: VoiceRole): string {
    return role === "alexa" ? "Flo (English (US))" : "Samantha";
  }

  protected async synthesize(text: string, voice: string, mp3: string): Promise<void> {
    const aiff = mp3.replace(/\.mp3$/, ".aiff");
    await run("say", ["-v", voice, "-o", aiff, "--", text], { timeout: 20_000 });
    await run(this.ffmpeg, ["-loglevel", "error", "-y", "-i", aiff, "-ac", "1", "-b:a", "48k", mp3], { timeout: 20_000 });
    try {
      unlinkSync(aiff);
    } catch {
      // leftover temp file is harmless
    }
  }
}
