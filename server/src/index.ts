// Starts CallAssist locally: MCP server, phone network, emulator and pages.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Assistant } from "./assistant.js";
import { createApp } from "./app.js";
import { Store } from "./store.js";
import { LocalPhoneNetwork } from "./telephony.js";
import { LocalTts, PollyTts, type Tts } from "./tts.js";
import { LocalOutbox } from "./email.js";
import { AuthServer } from "./auth.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { ConnectTelephony, ConnectWebCallTelephony, TelephonyRouter, awsConnectApi } from "./connect.js";
import { SipBroker, SipTelephony } from "./sip.js";
import { AwsPhoneSpeech } from "./speech.js";
import { NovaPlanner } from "./emulator/nova.js";
import { skillText } from "./ui.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const fast = process.env.DEMO_FAST === "1";

const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));

const outbox = new LocalOutbox(join(root, "data/local/outbox"));
const store = Store.fromFile(join(root, "data/seed.json"), process.env.NO_PERSIST ? undefined : join(root, "data/local/state.json"), join(root, "data/local/contacts.json"));
const phone = new LocalPhoneNetwork();

// Amazon Connect (US) when configured. Each contact's `line` picks local demo phone vs. real call.
const connectApi =
  process.env.CONNECT_INSTANCE_ID && process.env.CONNECT_CONTACT_FLOW_ID
    ? awsConnectApi({
        // The Connect instance may live in another region than the server (e.g. us-west-2).
        region: process.env.CONNECT_REGION ?? process.env.AWS_REGION ?? "us-east-1",
        instanceId: process.env.CONNECT_INSTANCE_ID,
        contactFlowId: process.env.CONNECT_CONTACT_FLOW_ID,
        sourcePhoneNumber: process.env.CONNECT_SOURCE_NUMBER ?? "",
      })
    : undefined;
// Real phone calls need a claimed number; browser calls only need the instance and flow.
const connect = connectApi && process.env.CONNECT_SOURCE_NUMBER ? new ConnectTelephony(connectApi, log) : undefined;
const webCalls = connectApi ? new ConnectWebCallTelephony(connectApi, phone, log) : undefined;
// SIP line (Asterisk + Airtel) for India testing: calls wait for the sip-bridge program to connect.
const sip = new SipTelephony(new SipBroker(), log);
const defaultLine = process.env.CONNECT_DEFAULT_LINE ?? "local";
const lines = new TelephonyRouter(
  { local: phone, sip, ...(connect ? { connect } : {}), ...(webCalls ? { "connect-web": webCalls } : {}) },
  (call) => store.contact(call.contactId)?.line ?? defaultLine,
);
const assistant = new Assistant(
  store,
  lines,
  {
    // DEMO_FAST=1 shortens waits so retries and follow-ups show up within a minute.
    ringTimeoutMs: connectApi ? 50_000 : fast ? 20_000 : 30_000,
    retryDelayMs: fast ? 20_000 : 120_000,
    followUpGraceMs: fast ? 15_000 : 120_000,
    mailer: outbox,
    // CALLING_HOURS=off lifts the 8 AM–9 PM rule, for late-night demo recording only.
    ...(process.env.CALLING_HOURS === "off" ? { callingHours: null } : {}),
  },
  log,
);
// Voices: Amazon Polly generative (closest to Alexa+) on AWS, or locally with TTS_ENGINE=polly and AWS
// credentials; otherwise the Mac's built-in voices.
const ttsEngine = process.env.TTS_ENGINE ?? (process.env.PUBLIC_URL?.startsWith("https://") ? "polly" : "say");
const tts: Tts = ttsEngine === "polly" ? new PollyTts(join(root, "data/local/tts")) : new LocalTts(join(root, "data/local/tts"), process.env.FFMPEG ?? "ffmpeg");
// The Alexa+ emulator understands free-form requests with Amazon Nova Pro on AWS (ALEXA_BRAIN=rules turns it off;
// ALEXA_BRAIN=nova turns it on locally with AWS credentials).
const alexaBrain = process.env.ALEXA_BRAIN ?? (ttsEngine === "polly" ? "nova" : "rules");
const alexaPlanner = alexaBrain === "nova" ? new NovaPlanner(skillText().body, process.env.ALEXA_MODEL ?? "us.amazon.nova-pro-v1:0") : undefined;
const phoneSpeech = ttsEngine === "polly" ? new AwsPhoneSpeech((process.env.PHONE_VOICE as "Kajal" | undefined) ?? "Kajal", (process.env.SIP_LANGUAGE as "en-IN" | undefined) ?? "en-IN", process.env.PHONE_VOICE_ENGINE === "generative" ? "generative" : "neural") : undefined;

// Local secrets (git-ignored). On AWS these live in Secrets Manager.
const secretsFile = join(root, "data/local/secrets.json");
mkdirSync(join(root, "data/local"), { recursive: true });
// On AWS, MASTER_SECRET comes from Secrets Manager and each OAuth client secret is derived from it,
// so the Connect Lambda can derive the same phone-agent secret without another stored secret.
const derive = (master: string, label: string) => createHmac("sha256", master).update(label).digest("base64url");
let secrets: { jwt: string; alexa: string; agent: string; sip?: string };
if (process.env.MASTER_SECRET) {
  const m = process.env.MASTER_SECRET;
  secrets = { jwt: derive(m, "jwt"), alexa: derive(m, "client:alexa-plus-emulator"), agent: derive(m, "client:connect-phone-agent"), sip: derive(m, "client:sip-bridge") };
} else {
  secrets = existsSync(secretsFile)
    ? JSON.parse(readFileSync(secretsFile, "utf8"))
    : { jwt: randomBytes(32).toString("hex"), alexa: randomBytes(24).toString("base64url"), agent: randomBytes(24).toString("base64url") };
  secrets.sip ??= randomBytes(24).toString("base64url");
  writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

const origin = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const authOn = process.env.AUTH !== "off";
const auth = authOn
  ? new AuthServer(
      {
        issuer: origin,
        resource: `${origin}/mcp`,
        agentResource: `${origin}/agent/mcp`,
        secret: secrets.jwt,
        userId: "user-manoj",
        userName: store.user.name,
        clients: [
          { clientId: "alexa-plus-emulator", clientSecret: secrets.alexa, name: "Alexa", redirectUris: [`${origin}/alexa/callback`, `http://localhost:${PORT}/alexa/callback`, `http://127.0.0.1:${PORT}/alexa/callback`], serviceScopes: ["mcp:service"] },
          { clientId: "connect-phone-agent", clientSecret: secrets.agent, name: "Amazon Connect phone agent", redirectUris: [], serviceScopes: ["agent:calls"] },
          { clientId: "sip-bridge", clientSecret: secrets.sip!, name: "SIP bridge (Asterisk)", redirectUris: [], serviceScopes: ["agent:calls"] },
        ],
      },
      log,
    )
  : undefined;

const app = createApp({
  assistant,
  phone,
  tts,
  publicDir: join(root, "public"),
  selfMcpUrl: `http://127.0.0.1:${PORT}/mcp`,
  allowedHosts: HOST === "127.0.0.1" || HOST === "localhost" ? ["127.0.0.1", "localhost"] : [],
  allowedOrigins: [origin, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`],
  trustProxy: process.env.TRUST_PROXY === "1",
  log,
  connect,
  webCalls,
  sip,
  phoneSpeech,
  outbox,
  emitMetrics: process.env.EMF === "1",
  alexaPlanner,
  auth,
  alexaAuth: auth
    ? { tokenUrl: `http://127.0.0.1:${PORT}/oauth/token`, authorizeUrl: `${origin}/oauth/authorize`, clientId: "alexa-plus-emulator", clientSecret: secrets.alexa, resource: `${origin}/mcp`, redirectUri: `${origin}/alexa/callback` }
    : undefined,
});

assistant.start();
void alexaPlanner?.warm();
app.listen(PORT, HOST, () => {
  console.log(`CallAssist running on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`  Alexa+ emulator  /alexa`);
  console.log(`  Worker phones    /phones`);
  console.log(`  Call console     /console`);
  console.log(`  MCP endpoint     /mcp   (phone agent: /agent/mcp)`);
  console.log(`  OAuth            ${authOn ? "on (/oauth/token, /oauth/authorize)" : "OFF (AUTH=off)"}`);
  console.log(`  Alexa brain      ${alexaPlanner ? `${alexaPlanner.name} + fast rules` : "rules"}`);
  console.log(`  Voices           ${tts.engine}${tts.available ? "" : " (unavailable: browser voices)"}`);
  console.log(`  Phone lines      local demo phones${webCalls ? " + Amazon Connect browser calls" : ""}${connect ? " + Amazon Connect phone calls" : ""} + SIP bridge (default: ${defaultLine})`);
});
