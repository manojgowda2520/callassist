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

CallAssist does two jobs, both by phone: **booking appointments** with local businesses, and **passing messages** to the user's trusted contacts and bringing back the reply.

**Job 1: appointments**

| Tool | Customer intent | Auth tier | Notes |
| --- | --- | --- | --- |
| `find_providers` | "Find me a … near …" | 1 | Returns in under 3 s. Up to 5 options (we use 3) and a `searchId`. Sorts by rating, distance or price |
| `request_quotes` | "Call them and ask" | 2 | Starts the calls. Returns an `errandId` and an interim message |
| `book_appointment` | "Book the 3:30" | 2 | Read-back first, then executes only with explicit confirmation. Blocks duplicate bookings |
| `list_appointments` | "What's coming up?" | 2 | Current status with key details |
| `reschedule_appointment` | "Move it to Friday" | 2 | Changes one parameter and keeps the rest |
| `cancel_appointment` | "Cancel my haircut" | 2 | Reads back the business's cancellation policy, requires confirmation, then calls the business to cancel |

**Job 2: messages to trusted contacts**

| Tool | Customer intent | Auth tier | Notes |
| --- | --- | --- | --- |
| `find_contact` | "Call Grandma" / "Tell Manju…" | 2 | Looks up the name in the user's own trusted contacts. Asks which one when two match |
| `call_contact` | "Tell Grandma I'll pick her up at 5, and ask if she needs anything" | 2 | Reads back who will be called and the exact message, waits for "yes", then calls. Can carry one question and bring back the answer |

**Shared by both jobs**

| Tool | Customer intent | Auth tier | Notes |
| --- | --- | --- | --- |
| `get_call_status` | "What did they say?" | 2 | Status and result of any call: quotes, a booking, or a contact's reply. Safe to call repeatedly |

**Tools the phone agent uses** (through AgentCore Gateway): `get_call_brief`, `report_quote`, `report_booking`, `report_reply`. Each errand's brief tells the agent which job it's doing: `inquiry`, `booking` or `message`.

Rules from Functional Requirements §13 that every tool follows:
- Every listed tool works; there are no placeholders.
- Every input has a valid JSON Schema, and the server validates arguments before acting.
- Failures return `isError: true` or a JSON-RPC error.
- Each tool maps to one intent, and its description makes no overclaims.
- Parameter descriptions include synonyms ("hair salon, barber, haircut"; "OB-GYN, gynecologist, women's health").
- Every call and response is logged.
- The schema has no fields unrelated to the stated purpose (Policy §3).

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

Booking a sick child's pediatrician visit means passing a child's name and symptoms to a clinic. That collides with Policy §4 ("must never target children or collect their data"). So the demo uses two adult scenes:

1. **Appointments (lead):** Maya books **her own OB/GYN new-patient visit**. The 2025 national average wait for OB/GYN is 42 days, the longest of any specialty. CallAssist calls three offices and finds an opening this week.
2. **Message:** "Tell Grandma I'll pick her up at 5, and ask if she needs anything from the store." CallAssist calls Grandma's landline and brings back "milk and bread." This shows CallAssist reaching people who don't use apps.

## 8. Listing assets to include in the repo

The Metadata section requires these:
- Name: "CallAssist", which is easy to say and doesn't clash with Alexa commands
- Plain-language description that discloses the booking capability, the message calls to trusted contacts, and the data collected
- At least 3 example phrases
- Icon
- Privacy Policy and Terms of Use pages, hosted with the simulator
