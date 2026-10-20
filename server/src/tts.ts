// Local text-to-speech for the phone network: macOS `say` + ffmpeg → mp3,
// cached by text. On Amazon Connect, Nova Sonic speaks instead.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const VOICES = { agent: "Samantha", alexa: "Flo (English (US))" } as const;

export class LocalTts {
  private inflight = new Map<string, Promise<string>>();
  available = process.platform === "darwin";

  constructor(private dir: string, private ffmpeg = "ffmpeg") {
    mkdirSync(dir, { recursive: true });
  }

  key(text: string, voice: string): string {
    return createHash("sha1").update(`${voice}\n${text}`).digest("hex").slice(0, 20);
  }

  /** Returns the mp3 path for this text, making it if needed. */
  async file(text: string, voice: string = VOICES.agent): Promise<string> {
    const clean = text.replace(/[\u0000-\u001f]+/g, " ").slice(0, 400);
    const k = this.key(clean, voice);
    const mp3 = join(this.dir, `${k}.mp3`);
    if (existsSync(mp3)) return mp3;
    const busy = this.inflight.get(k);
    if (busy) return busy;
    const job = (async () => {
      const aiff = join(this.dir, `${k}.aiff`);
      await run("say", ["-v", voice, "-o", aiff, "--", clean], { timeout: 20_000 });
      await run(this.ffmpeg, ["-loglevel", "error", "-y", "-i", aiff, "-ac", "1", "-b:a", "48k", mp3], { timeout: 20_000 });
      try {
        unlinkSync(aiff);
      } catch {
        // leftover temp file is harmless
      }
      return mp3;
    })().finally(() => this.inflight.delete(k));
    this.inflight.set(k, job);
    return job;
  }
}
