# CallAssist: your personal assistant, on the phone

CallAssist is an Alexa+ add-on, built as an MCP server, that phones your people for you. Tell Alexa what needs doing. CallAssist calls the right person on your team, explains the job, gets a yes and a time, follows up after the deadline, and tells you when it's done.

> Status: built for the Amazon "Build, Ship, Shape" hackathon (Alexa+ track, plus the AWS Builder and Open Source mini challenges). Runs fully on your computer today; the AWS deployment (Amazon Connect + Nova Sonic) uses the same code paths.

```
 A  You          "Alexa, ask Raju to set up the meeting room by 3."
 B  Alexa+       reads it back, waits for your "yes"
 C  CallAssist   calls Raju in an AI voice, gets "okay, by 3", follows up at 3, reports back
 D  Your team    Raju answers his normal phone. No app. He can call back any time.
```

## What you can say

> "Alexa, get me a coffee." (a preset errand: calls the office pantry)
> "Alexa, ask Raju to set up the meeting room for the client at 3."
> "Alexa, tell Grandma I'll pick her up at 5 and ask if she needs anything from the store."
> "Alexa, what's pending?" · "Any update from Raju?" · "Follow up with the driver." · "Tell him it's room 3." · "Cancel the coffee."

## MCP tools

| Tool | What it does |
| --- | --- |
| `assign_task` | Gives one of your people a task by phone, with an optional deadline |
| `run_errand` | Runs a preset errand (coffee, tea, lunch, the car) at the office or at home |
| `deliver_message` | Delivers a message plus one question and brings back the reply |
| `get_task_status` / `list_tasks` | One task's status / several tasks |
| `follow_up` | Calls now for an update |
| `answer_question` | When someone asked a question about their task, calls them back with your answer |
| `cancel_task` | Cancels, and tells the person if they had started |
| `list_team` / `list_errands` | Who CallAssist can call / which errands are set up |

The Amazon Connect phone agent uses two more tools on a separate endpoint (`/agent/mcp`): `get_call_brief` and `report_outcome`.

## Safety, enforced by the server

- **Your yes is checked, not assumed.** A read-back returns a one-time token bound to exactly what was read back. Without it, nobody is called. The same token stops a retry from calling twice.
- **Every call says it's an AI**, who it's for, and that the person can say "stop". "Stop" means never again (timestamped do-not-call list).
- **Consent is a record** (when, how, exact words). No record, no call.
- **Calling hours:** 8 AM to 9 PM in the called person's time zone. Outside that, the call is scheduled and you're told.
- **Limits:** at most 5 calls at once, daily caps per person and overall, rate limits on every endpoint.
- **Declined:** emergencies (sent to 911) and tasks about children (Alexa+ Policy §4).
- **Privacy:** no call recording; logs keep request shapes, not what people said; phone numbers masked on web pages; closed tasks deleted after 30 days. See [Privacy](server/public/privacy.html) and [Terms](server/public/terms.html).
- **OAuth exactly as Alexa+ expects:** service tokens (`client_credentials`, `mcp:service`) can only initialize and list tools; tool calls need a user token from account linking (authorization code + PKCE S256, `mcp:tools`). Each account's data is kept apart.

## Run it locally

Everything runs on one computer: the MCP server, an Alexa+ emulator, a local phone network for your team, and a call console. On a Mac, the phones speak with macOS voices.

```bash
cd server
npm install
DEMO_FAST=1 npx tsx src/index.ts
```

Then open:

| Page | What it is |
| --- | --- |
| http://localhost:8787/alexa | Alexa+ emulator: an Echo Show stand-in. Link the account once, then talk or type. Shows the real MCP traffic |
| http://localhost:8787/phones | Your team's phones. They ring, speak and listen |
| http://localhost:8787/console | Every task, call transcript, update and email, live |

Options: `DEMO_FAST=1` shortens retry and follow-up waits. `CALLING_HOURS=off` lifts the 8 AM–9 PM rule (for recording a demo at night). `AUTH=off` turns OAuth off. `EMF=1` prints CloudWatch metric lines.

## Tests

```bash
cd server
npm test
```

107 tests run against a real server on a random port, with "worker bots" answering the local phones:

| Suite | Covers |
| --- | --- |
| `protocol` | Negotiates 2025-03-26 (Alexa+) and 2025-11-25; every tool has input and output schemas; 405/403/parse errors; metrics; no personal data in logs; rate limits |
| `auth` | Both OAuth tiers, RFC 6749 errors, PKCE, one-time codes, refresh rotation, revocation, expiry, forged tokens, wrong audience, separate phone-agent token, two accounts can't see each other |
| `safety` | Forged or swapped confirmations, retries, consent, opt-out (and plain "stop"), emergencies, children, calling hours, daily caps, duplicates, hostile input, caller can't take over, no IDs spoken |
| `flows` | Accept, decline, question then answer, problem then answer, automatic follow-up, no answer, rejected, hang-up, silence, unclear, cancel, inbound update, messages, parallel calls, Connect agent tools, email receipts, retention |
| `emulator` | 25 natural phrasings to the right tool, full voice conversations, link-first behaviour, replies under 30 seconds with no screen references |
| `unit` | Time parsing, what people say on the phone, wording helpers, persistence |
| `more` | 50 phrasings across the main tools, 10 hostile callers, edge times, answers held until calling hours, follow-up limits, bursts past the call limit |

## Built with

- MCP TypeScript SDK, Streamable HTTP (stateless), spec 2025-11-25 with negotiation down to 2025-03-26
- Planned on AWS (us-east-1): Amazon Connect + Nova Sonic speech-to-speech for calls; Amazon Bedrock AgentCore Gateway for the phone-agent tools; Amazon Cognito; Amazon DynamoDB (per-user keys, TTL); Amazon SES; CloudWatch (EMF metrics); CloudFormation deployed by GitHub Actions with OIDC

## Docs

- [Alexa+ design rules and how CallAssist follows them](docs/alexa-plus-design-rules.md)
- [How AWS engineers would build CallAssist (research)](docs/research-how-aws-builds-mcp.md)
- [Calling by region](docs/telephony-regions.md)
- [Friction log](FRICTION_LOG.md)

## License

MIT. See [LICENSE](LICENSE).
