// Starts CallAssist locally: MCP server, phone network, emulator and pages.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Assistant } from "./assistant.js";
import { createApp } from "./app.js";
import { Store } from "./store.js";
import { LocalPhoneNetwork } from "./telephony.js";
import { LocalTts } from "./tts.js";
import { LocalOutbox } from "./email.js";
import { AuthServer } from "./auth.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const fast = process.env.DEMO_FAST === "1";

const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));

const outbox = new LocalOutbox(join(root, "data/local/outbox"));
const store = Store.fromFile(join(root, "data/seed.json"), process.env.NO_PERSIST ? undefined : join(root, "data/local/state.json"));
const phone = new LocalPhoneNetwork();
const assistant = new Assistant(
  store,
  phone,
  {
    // DEMO_FAST=1 shortens waits so retries and follow-ups show up within a minute.
    ringTimeoutMs: fast ? 20_000 : 30_000,
    retryDelayMs: fast ? 20_000 : 120_000,
    followUpGraceMs: fast ? 15_000 : 120_000,
    mailer: outbox,
    // CALLING_HOURS=off lifts the 8 AM–9 PM rule, for late-night demo recording only.
    ...(process.env.CALLING_HOURS === "off" ? { callingHours: null } : {}),
  },
  log,
);
const tts = new LocalTts(join(root, "data/local/tts"), process.env.FFMPEG ?? "ffmpeg");

// Local secrets (git-ignored). On AWS these live in Secrets Manager.
const secretsFile = join(root, "data/local/secrets.json");
mkdirSync(join(root, "data/local"), { recursive: true });
const secrets = existsSync(secretsFile)
  ? JSON.parse(readFileSync(secretsFile, "utf8"))
  : { jwt: randomBytes(32).toString("hex"), alexa: randomBytes(24).toString("base64url"), agent: randomBytes(24).toString("base64url") };
writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });

const origin = `http://localhost:${PORT}`;
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
          { clientId: "alexa-plus-emulator", clientSecret: secrets.alexa, name: "Alexa", redirectUris: [`${origin}/alexa/callback`, `http://127.0.0.1:${PORT}/alexa/callback`], serviceScopes: ["mcp:service"] },
          { clientId: "connect-phone-agent", clientSecret: secrets.agent, name: "Amazon Connect phone agent", redirectUris: [], serviceScopes: ["agent:calls"] },
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
  selfMcpUrl: `http://localhost:${PORT}/mcp`,
  allowedHosts: HOST === "127.0.0.1" || HOST === "localhost" ? ["127.0.0.1", "localhost"] : [],
  allowedOrigins: [origin, `http://127.0.0.1:${PORT}`],
  log,
  outbox,
  emitMetrics: process.env.EMF === "1",
  auth,
  alexaAuth: auth
    ? { tokenUrl: `http://127.0.0.1:${PORT}/oauth/token`, authorizeUrl: `${origin}/oauth/authorize`, clientId: "alexa-plus-emulator", clientSecret: secrets.alexa, resource: `${origin}/mcp`, redirectUri: `${origin}/alexa/callback` }
    : undefined,
});

assistant.start();
app.listen(PORT, HOST, () => {
  console.log(`CallAssist running on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`  Alexa+ emulator  /alexa`);
  console.log(`  Worker phones    /phones`);
  console.log(`  Call console     /console`);
  console.log(`  MCP endpoint     /mcp   (phone agent: /agent/mcp)`);
  console.log(`  OAuth            ${authOn ? "on (/oauth/token, /oauth/authorize)" : "OFF (AUTH=off)"}`);
});
