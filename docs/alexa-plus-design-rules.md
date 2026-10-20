# Alexa+ design rules for CallAssist

How each rule in Amazon's Alexa+ add-on docs shapes the CallAssist MCP server. Reviewed 2026-10-14.

Sources:
- [MCP Client and App Lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html)
- [Authentication](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html)
- [Functional Requirements](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html)
- [Policy Requirements](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html)
- [MCP Design Guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-design-guide.html) (the landing page is only a table of contents; the rules live on its subpages)

## 1. Protocol version: support both

- The Alexa+ client's sample `initialize` sends protocol version **2025-03-26**. Its `clientInfo` is `"Alexa+ MCP Client"` 1.0.0, and its only declared capability is `roots`.
- The hackathon rules require the server to implement **2025-11-25** or later.

**Decision:** the server speaks 2025-11-25 and negotiates down to 2025-03-26 when that's what the client sends. Newer features turn on only when the client declares them:

| Feature | When the client declares it (our simulator, Claude) | When it doesn't (Alexa+ as documented) |
| --- | --- | --- |
| Tasks (long-running calls) | `request_quotes` or `call_contact` returns a task; the client polls `tasks/get` | The tool returns right away with an `errandId`; the client calls `get_call_status` |
| Elicitation (confirm, missing details) | A form asks for name and phone, or for Confirm | A two-step tool call: the first returns a read-back, the second carries `confirmed: true` |
| UI (`_meta.ui.resourceUri`) | Live call cards and an options carousel | Alexa+ renders from `structuredContent` (its documented data-only flow) |

## 2. Authentication

Alexa+ uses two tiers. Both follow the checklist on the Authentication page.

**Tier 1, service token (client credentials).** Used for `initialize`, `tools/list` and search.
- `POST /token`, form-encoded, client authenticated with HTTP Basic. Credentials in the POST body are also accepted.
- Required parameters: `grant_type=client_credentials`, `scope=mcp:service`, and `resource`, the canonical MCP server URI. The server validates `resource`.
- `expires_in` ≤ 3600, `token_type: "Bearer"`, **no refresh token**, scopes limited to `mcp:service`.
- Never accept credentials in the query string.
- Errors use the RFC 6749 §5.2 format: 401 `invalid_client`, 400 `invalid_scope` / `invalid_request`, 403 `access_denied`.
- A service token never reaches user data.

**Tier 2, user token (authorization code + PKCE S256).** Used for tools that touch a customer's own data, such as booking or listing appointments. Scope `mcp:tools`.
- Return **401** when a token is expired or invalid, so Alexa+ re-links.
- Scope every record to the current token's user.

**Not supported by Alexa+:** Dynamic Client Registration, OpenID Connect, step-up authorization, and `WWW-Authenticate` headers on 401.

**Open question:** does a Cognito user pool validate the RFC 8707 `resource` parameter? If not, we write a small token Lambda that does.

## 3. Tools: one customer intent each, chained by stable IDs

CallAssist is a **personal assistant on the phone**. The user tells Alexa+ what needs doing; CallAssist calls the right person on the user's team (staff, home help, family), hands over the task, gets a yes and a time, follows up, and reports back. (Updated 2026-10-21: the earlier appointment-booking tools were replaced by this task model.)

| Tool | Customer intent | Auth tier | Notes |
| --- | --- | --- | --- |
| `assign_task` | "Ask Raju to set up the meeting room by 3" | 2 | Read-back first, then runs only with `confirmed=true` **and** the read-back's `confirmationToken`. Parses a due time |
| `run_errand` | "Get me a coffee" | 2 | Preset errands (coffee, tea, lunch, the car); picks the person by place (office/home). Same read-back gate |
| `deliver_message` | "Tell Grandma I'll pick her up at 5 and ask if she needs anything" | 2 | Delivers a message plus at most one question; brings back the reply. Never connects the user into a live call |
| `get_task_status` | "What did Raju say?" | 2 | One task. Safe to repeat. Optional `waitSeconds` (default 0) |
| `list_tasks` | "What's pending?" | 2 | Several tasks; at most 5 spoken, "and N more" |
| `follow_up` | "Check with the driver" | 2 | Calls now for an update on an open task |
| `answer_question` | "Tell him it's room 3" | 2 | When a worker asked a question or hit a problem, calls them back with the user's answer |
| `cancel_task` | "Cancel the coffee" | 2 | Read-back gate; tells the worker if they had already started |
| `list_team` | "Who can you call?" / "Is Ravi on my list?" | 2 | Whole team, or one lookup by name, nickname or role. Asks "which one?" when two match |
| `list_errands` | "What can you get me?" | 2 | Preset errands |

**Phone-agent tools** (for the Amazon Connect AI agent, through AgentCore Gateway, at `/agent/mcp` with their own `agent:calls` token): `get_call_brief` (who, for whom, disclosure, script, goal, rules) and `report_outcome` (`accept`, `decline`, `done`, `blocked`, `question`, `optout`, plus the person's words and an ETA).

Every tool:
- Has a JSON Schema input (zod, validated before acting) **and a declared `outputSchema`**; the result's `structuredContent.speech` equals the spoken text.
- Returns `isError: true` with a spoken next step on failure. Never speaks IDs, codes or tool names.
- Carries annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`). These are hints only; the server enforces the real rules.
- Is logged as tool name, argument *shape* (no personal data), result and latency, plus CloudWatch EMF metrics.

### Server-enforced confirmation (OWASP LLM06)

A read-back returns a one-time `confirmationToken` bound to the exact tool, person and words. `confirmed=true` without that token, or with a token for anything else, calls nobody and returns a fresh read-back. The same token is the idempotency key: if Alexa+ retries a confirmed call, the first result comes back and nobody is called twice.

### Calling law as code

- Consent is a dated record (when, how, exact wording). No record → no call.
- Every call opens: "Hi {name}, this is CallAssist, an AI assistant calling for {user}, on behalf of Mobil80. You can say stop at any time." It ends with the callback number.
- "Stop" or "don't call me" opts the person out forever, with a timestamp (internal do-not-call list).
- Calls happen only 8 AM to 9 PM in the **called person's** time zone; outside that, the call is scheduled and the user is told.
- Rolling 24-hour caps per person and overall. Calls are not recorded.
- Tasks about children are declined (Policy §4). Emergencies are sent to 911 (Policy §13).

## 4. Voice and screen

- Spoken text never mentions a screen. All critical facts (price, time, name) are available by voice.
- Present 5 options at most. Read back the key details and require an explicit "yes" before booking or cancelling.
- When a call is slow, send an interim message such as "Calling three offices now. This takes a couple of minutes."
- Never show API codes, tool names, JSON or internal IDs to the customer. Every error offers a next step.
- What is shown and what is spoken never contradict each other. Cards update in step with the voice.

## 5. Booking and policy rules

- Confirm the booking details by voice before executing (Policy §15).
- After a booking, confirm by voice **and** by email (SES) (Policy §15).
- The customer can cancel at any time, including in a later conversation.
- Show a one-time permission prompt before first use, and disclose the data collected: name, callback phone, insurance carrier, trusted contacts (Policy §3).
- Read back the exact message and who will be called before any `call_contact`, and wait for an explicit "yes".
- Collect only what each booking needs. Never read private data aloud. Delete call data after the booking is done.
- No payments in v1, so the purchase rules (>$100 voice code and the rest) don't apply.
- **Health (§13):** never claim emergency help; say "for emergencies, call 911"; include a short "not medical advice" line.
- **Children (§4):** "Your add-on must never target children or collect their data." See the next section.

## 6. Trusted contacts and consent

- **Where contacts come from.** CallAssist can't read the contacts synced to the user's Alexa account. Add-ons get no access to them, and Policy §3 rejects add-ons that collect data about the customer's Alexa environment. CallAssist keeps its own **trusted contacts** list, added on CallAssist's web page: name, relationship or role, phone number. Signing in with Google Contacts (read-only) is a later option.
- **Only trusted contacts get called.** Each contact is added on purpose by the user. A contact must have agreed to receive calls from CallAssist, because US rules require prior consent for AI-voice calls to mobile numbers.
- **Opt-out.** If a contact says "don't call me again", CallAssist marks them and never calls them again.
- **Disclosure.** Every call opens with "This is CallAssist, an AI assistant calling for {user}."
- **Minimum data.** CallAssist stores only name, label and number per contact, and never reads numbers aloud.
- **Demo.** Every contact in the demo is a volunteer who agreed in writing.

## 6b. Living next to Alexa's built-in calling and messaging

Alexa already has calling and messaging. "Alexa, call Mom" connects **you** to Mom like a phone call. "Send a message to Mom" sends a voice or text message to her Alexa app. CallAssist's tools must not compete with those commands.

| | Built-in Alexa calling and messaging | CallAssist |
| --- | --- | --- |
| Who talks on the call | You | CallAssist's AI voice, for you |
| What comes back | Nothing; you hear it live, or the message is just delivered | The other person's answer, reported back to you |
| Who it reaches | Contacts with a phone, or with the Alexa app for messaging | Any phone, including landlines, with no app needed |
| Businesses | Not supported | Prices, open slots, booking |

Rules that follow from this:

- **Don't claim plain calling.** `call_contact` never connects the user into a live call. Its description says it delivers a message and brings back the reply.
- **Use delegation wording** in tool descriptions and example phrases: "have CallAssist call…", "ask Grandma if…", "find out from Manju whether…". This leaves "call Mom" to Alexa.
- **Partners first for bookings.** If a business can be booked through an Alexa+ partner (Vagaro, Thumbtack and others), that path is better. CallAssist handles businesses that only answer the phone.

## 7. Demo story

The user is Maya, who runs a small office and a busy home. Three scenes, all adults, all volunteers who agreed in writing:

1. **Errand:** "Alexa, get me a coffee." CallAssist reads back, Maya says yes, Raju in the pantry answers his phone and says "ten minutes". Alexa tells Maya.
2. **Task with a question:** "Ask Raju to set up the meeting room for the client at 3." Raju asks "Which room?" Alexa asks Maya; she says "Tell him room 3." CallAssist calls Raju back. After 3 PM it follows up by itself and reports "done".
3. **Message:** "Tell Grandma I'll pick her up at 5, and ask if she needs anything from the store." CallAssist calls Grandma's landline and brings back "milk and bread". This shows CallAssist reaching people who don't use apps.

## 8. Listing assets to include in the repo

The Metadata section requires these:
- Name: "CallAssist", which is easy to say and doesn't clash with Alexa commands
- Plain-language description that discloses the booking capability, the message calls to trusted contacts, and the data collected
- At least 3 example phrases
- Icon
- Privacy Policy and Terms of Use pages, hosted with the simulator
