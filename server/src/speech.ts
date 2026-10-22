// Telephone-quality speech for the SIP line, done on the server so the PBX
// needs no AWS keys: Amazon Polly makes 8 kHz audio for Asterisk to play, and
// Amazon Transcribe turns the recorded reply into text.
import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from "@aws-sdk/client-polly";
import { StartStreamTranscriptionCommand, TranscribeStreamingClient, type LanguageCode } from "@aws-sdk/client-transcribe-streaming";

export interface PhoneSpeech {
  /** 8 kHz, 16-bit, mono WAV of the text, ready for Asterisk. */
  wav8k(text: string): Promise<Buffer>;
  /** Text of a recorded reply (8 kHz 16-bit mono WAV or raw PCM). */
  transcribe(audio: Buffer): Promise<string>;
}

/** Wraps raw 16-bit mono PCM in a WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate = 8000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Raw PCM samples from a WAV file (finds the "data" chunk), or the buffer itself if it isn't WAV. */
export function wavToPcm(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  return Buffer.alloc(0);
}

export class AwsPhoneSpeech implements PhoneSpeech {
  private polly: PollyClient;
  private transcribeClient: TranscribeStreamingClient;

  constructor(
    private voice: VoiceId = "Matthew",
    private language: LanguageCode = "en-IN",
    region = process.env.AWS_REGION ?? "us-east-1",
  ) {
    this.polly = new PollyClient({ region });
    this.transcribeClient = new TranscribeStreamingClient({ region });
  }

  async wav8k(text: string): Promise<Buffer> {
    const out = await this.polly.send(
      new SynthesizeSpeechCommand({ Engine: "generative", VoiceId: this.voice, OutputFormat: "pcm", SampleRate: "8000", Text: text.slice(0, 1500), TextType: "text" }),
    );
    if (!out.AudioStream) throw new Error("Polly returned no audio");
    return pcmToWav(Buffer.from(await out.AudioStream.transformToByteArray()), 8000);
  }

  async transcribe(audio: Buffer): Promise<string> {
    const pcm = wavToPcm(audio);
    if (pcm.length < 1600) return ""; // under 0.1 s: nothing said
    async function* chunks() {
      for (let i = 0; i < pcm.length; i += 3200) yield { AudioEvent: { AudioChunk: pcm.subarray(i, i + 3200) } };
    }
    const res = await this.transcribeClient.send(
      new StartStreamTranscriptionCommand({ LanguageCode: this.language, MediaEncoding: "pcm", MediaSampleRateHertz: 8000, AudioStream: chunks() }),
    );
    const parts: string[] = [];
    for await (const ev of res.TranscriptResultStream ?? []) {
      for (const r of ev.TranscriptEvent?.Transcript?.Results ?? []) {
        if (!r.IsPartial && r.Alternatives?.[0]?.Transcript) parts.push(r.Alternatives[0].Transcript);
      }
    }
    return parts.join(" ").trim();
  }
}
