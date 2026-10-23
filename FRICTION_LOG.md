# Friction log

What we tried while building CallAssist (an Alexa+ add-on, as an MCP server, that phones the user's people), what worked, what didn't, and the workarounds we used. Entries use the format the hackathon asks for: task, steps, expected vs. actual, severity, workaround, suggestion. Newest first.

Severity: **Blocker** (can't proceed), **High** (big detour), **Medium** (slows down), **Low** (annoyance).

## Summary

| # | Product | Issue | Severity |
| --- | --- | --- | --- |
| 1 | Alexa+ add-ons | Tools (MCP Toolkit, web simulator) are partner-only; no way to test in real Alexa+ | High |
| 2 | Amazon Connect | Not available on AWS India (AISPL) accounts | Blocker (for India) |
| 3 | Connect + AgentCore Gateway | Connect's MCP client needs `2025-03-26` on the gateway; tools vanish silently otherwise | High |
| 4 | Alexa+ docs | No guidance for read-back/"yes" when the client doesn't declare elicitation | Medium |
| 5 | Alexa+ docs | No latency or timeout numbers for tool calls | Medium |
| 6 | Alexa+ docs | Client protocol `2025-03-26` vs hackathon minimum `2025-11-25` | Medium |
| 7 | AgentCore Runtime | Built-in auth style may not fit the Alexa+ OAuth checklist | Medium |
| 8 | Alexa+ Policy | Children's-data rule gives no guidance for incidental mentions in free text | Medium |
| 9 | Alexa+ docs | Refresh-token and 401/403 rules disagree between pages | Low |
| 10 | Alexa+ docs | Scope rules contradict each other on the Authentication page | Low |
| 11 | MCP TypeScript SDK (used to emulate Alexa+) | Client can't pin an older protocol version | Low |
| 12 | Alexa+ docs | Design Guide landing page has no rules; Supported Capabilities link broken | Low |
| 13 | Amazon Connect | New instances can't claim a number or place outbound calls (default quotas) | Blocker (for calls) |
| 14 | Amazon Polly | Generative voice adds 1–6 s per line on live phone calls | Medium |
| 15 | Amazon Bedrock (Nova Pro) | Model sometimes claims it did an action instead of calling the tool | High |

## What worked well

- **The Alexa+ docs themselves.** Functional Requirements, Policy Requirements and the Authentication checklist are concrete enough to turn into tests. We wrote one test per MUST we could find (token tiers, PKCE S256, no `WWW-Authenticate`, ≤5 options, no IDs in speech, read-back before action).
- **Self-hosted MCP + our own client is allowed.** The FAQ answer let us build a local Alexa+ emulator that is a real MCP client and negotiates `2025-03-26`, so we could test every flow end to end without partner access.
- **MCP protocol negotiation.** The official TypeScript SDK negotiated `2025-11-25` down to `2025-03-26` with no extra code on the server.
- **Amazon Connect's design maps cleanly to our model.** `StartOutboundVoiceContact` with contact attributes, plus an AI agent that calls MCP tools, matches our "call brief → report outcome" phone-agent tools one to one.
- **Structured output.** Declaring an `outputSchema` per tool caught two response-shape bugs in our own tests, because the SDK client validates every result.

---

## 2026-10-23 · Nova Pro said "I've called Neeta" without calling the tool

- **Tool:** Amazon Bedrock, Amazon Nova Pro (`us.amazon.nova-pro-v1:0`) through the Converse API with tool definitions
- **Task:** Let the Alexa+ emulator understand free-form requests by giving Nova Pro the CallAssist MCP tools.
- **Steps:** Ran the same conversation several times in one session; on a repeat, sent "Ask Neeta to schedule a meeting with the client at 11 am tomorrow".
- **Expected:** A `toolUse` block for `assign_task`, as on the first run.
- **Actual:** A plain-text answer, "I've called Neeta… Neeta has confirmed the meeting", with no tool call. Nothing was called (the server needs a real tool call and a confirmation token), but the user heard something untrue.
- **Severity:** High
- **Workaround:** The emulator never treats model text as an action. If the fast rules recognise a request and the model answers in words only, the rules' tool runs instead. Model text that claims a call, booking or confirmation is discarded. Covered by a test.
- **Suggestion:** A Converse option to require a tool call (like `toolChoice: any`) that also works across longer histories, and guidance on keeping conversation history from making the model answer "from memory".

## 2026-10-23 · Polly generative voice is slow for live phone turns

- **Tool:** Amazon Polly, generative engine, PCM 8 kHz output, used for real calls over a SIP line
- **Task:** Speak each line of a live phone call in the same voice as Alexa (Danielle, generative).
- **Steps:** Synthesised each reply when it was needed, after the caller stopped talking.
- **Expected:** Sub-second synthesis, similar to the neural engine.
- **Actual:** 1–6 s before a line could play, which left dead air at pickup and after each reply.
- **Severity:** Medium
- **Workaround:** The opening line is synthesised while the phone is still ringing; replies are cached per call; a short "Okay." plays the moment the caller stops talking. The neural engine is still available as a faster option.
- **Suggestion:** Publish latency numbers per engine, and offer streaming output for the generative engine so playback can start before the whole line is ready.

## 2026-10-22 · New Amazon Connect instances can't make outbound calls

- **Tool:** Amazon Connect (us-east-1 and us-west-2), `ClaimPhoneNumber` and `StartOutboundVoiceContact`
- **Task:** Claim a US number and place CallAssist's outbound calls through Connect.
- **Steps:** Created a new instance, claimed a number in the console and with the API, then started an outbound voice contact.
- **Expected:** A claimed number and an outbound call, within the documented default quotas.
- **Actual:** "Allowed limit for claimed phone numbers exceeded" when claiming, and "Call throttle limit exceeded" on outbound calls. It was the same on several new instances in two regions. The console didn't say the account's effective quota was zero.
- **Severity:** Blocker (for real calls through Connect)
- **Workaround:** Opened a support case for a quota increase; kept Connect wired (including WebRTC browser calling) and added a SIP bridge (Asterisk ARI over an Airtel trunk) to test real calls meanwhile.
- **Suggestion:** Show the effective quotas when an instance is created, link straight to the increase request, and say when a new account starts below the documented defaults.

---

## 2026-10-21 · No pattern for "read back, then wait for yes" without elicitation

- **Tool:** Alexa+ docs ([Functional Requirements §8, §9](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html), [Client lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html))
- **Task:** Make sure CallAssist never phones anyone without the user's explicit "yes".
- **Steps:** Read the confirmation rules, then the client lifecycle page to see how Alexa+ asks the user.
- **Expected:** A recommended pattern: elicitation, or a documented two-step tool call.
- **Actual:** The rules require a read-back and an explicit yes, but the documented client doesn't declare elicitation, and no two-step pattern is described. A plain `confirmed: true` flag can be set by the model without the user ever hearing the read-back.
- **Severity:** Medium
- **Workaround:** The read-back returns a one-time `confirmationToken` bound to the exact tool, person and words; the action runs only when that token comes back unchanged. The token also works as an idempotency key if Alexa+ retries. Covered by tests for forged, swapped and replayed confirmations.
- **Suggestion:** Document the recommended confirmation pattern for clients without elicitation, ideally with a server-verifiable example.

## 2026-10-21 · Children's-data rule vs. everyday personal-assistant requests

- **Tool:** Alexa+ Policy Requirements ([§4](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html))
- **Task:** Let users hand everyday tasks to their staff and family by voice.
- **Steps:** Read §4 ("must never target children or collect their data"), then listed common requests a busy parent would make.
- **Expected:** Guidance on incidental mentions, e.g. "pick up the parcel from my son's school".
- **Actual:** No guidance on free-text fields that may mention a child in passing. Many of the most common assistant requests (school pickup, daycare) touch this rule.
- **Severity:** Medium
- **Workaround:** CallAssist declines any task or message that mentions children (patterns such as "my son", "7-year-old", "daycare") with a polite spoken reason, and says so in its privacy policy.
- **Suggestion:** Add examples of allowed and not-allowed incidental mentions, or a recommended refusal wording.

## 2026-10-20 · MCP TypeScript SDK client can't pin an older protocol version

- **Tool:** MCP TypeScript SDK 1.32 (used to build our local Alexa+ emulator)
- **Task:** Make the emulator behave like the documented Alexa+ client, which sends `protocolVersion: "2025-03-26"`.
- **Steps:** Looked for a client option to choose the protocol version and client info.
- **Expected:** An option such as `protocolVersion` on `Client`.
- **Actual:** The client always sends the latest version. There is no option to pin an older one.
- **Severity:** Low
- **Workaround:** A small custom `fetch` for the Streamable HTTP transport rewrites the `initialize` request to `2025-03-26` with Alexa+'s client name and `roots` capability. The server then negotiates down, exactly as with real Alexa+.
- **Suggestion:** For Amazon: publish a tiny reference client (or a conformance script) that behaves like Alexa+, so entrants without partner access can test against the real handshake.

## 2026-10-21 · Amazon Connect's MCP client asks the Gateway for 2025-03-26

- **Tool:** Amazon Connect AI agents + Amazon Bedrock AgentCore Gateway ([Integrate an MCP server](https://docs.aws.amazon.com/connect/latest/adminguide/3p-apps-mcp-server.html))
- **Task:** Plan how the Connect phone agent reaches CallAssist's phone-agent tools.
- **Steps:** Read the Connect MCP integration guide and a field report of tools not appearing.
- **Expected:** A new gateway works with Connect out of the box.
- **Actual:** The guide says the gateway's Supported Versions must include `2025-03-26`, and the gateway ID must be in Allowed audiences. A developer reported tools silently missing with "Unsupported protocol version: 2025-03-26" ([Classmethod](https://dev.classmethod.jp/articles/amazon-connect-agentcore-gateway-tools-not-displayed/)). `UpdateGateway` replaces the whole version list.
- **Severity:** High
- **Workaround:** Add `2025-03-26` to the gateway's versions when creating it; our phone-agent server negotiates either version.
- **Suggestion:** Make `2025-03-26` a default for gateways used by Connect, or show a clear error in the Connect console.

## 2026-10-21 · Alexa+ docs disagree on refresh tokens and 401 vs 403

- **Tool:** Alexa+ MCP Toolkit docs ([Authentication](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html), [Account linking](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html))
- **Task:** Build the token endpoint.
- **Steps:** Read the tier 1 rules, then the account-linking page.
- **Expected:** One rule for refresh tokens and one status code for re-linking.
- **Actual:** Tier 1 says "no refresh token"; account linking says the endpoint must return one. One page says 401 triggers re-linking, another says 401/403.
- **Severity:** Low
- **Workaround:** No refresh token for `client_credentials`; rotating refresh tokens for the authorization-code grant; 401 (no `WWW-Authenticate`) whenever Alexa+ should re-link. Covered by 14 tests.
- **Suggestion:** Say on both pages that the rules differ by grant, and pick one status code.

## 2026-10-21 · AgentCore Runtime's built-in auth may not fit the Alexa+ checklist

- **Tool:** Amazon Bedrock AgentCore Runtime ([MCP on Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html))
- **Task:** Choose where to host the Alexa-facing MCP server.
- **Steps:** Compared Runtime's MCP endpoint and inbound auth with the Alexa+ authentication rules.
- **Expected:** Runtime can host an Alexa+ add-on server as is.
- **Actual:** Runtime serves MCP at a URL containing the URL-encoded agent ARN and answers a missing token with 401 plus `WWW-Authenticate`. Alexa+ doesn't support `WWW-Authenticate`, DCR or OIDC, and wants `/.well-known/oauth-protected-resource` on the server's own origin. (Our reading of the docs; to be confirmed on AWS.)
- **Severity:** Medium
- **Workaround:** Plan a custom domain in front of the server; keep AgentCore Gateway for the Connect-facing tools.
- **Suggestion:** Document an Alexa+-compatible Runtime setup, or a custom-domain option with plain OAuth metadata.

## 2026-10-21 · No latency or timeout numbers for Alexa+ tool calls

- **Tool:** Alexa+ docs ([Client lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html), [Test your add-on CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html))
- **Task:** Set a latency budget and timeouts for each tool.
- **Steps:** Looked for client timeouts, retries and voice latency targets.
- **Expected:** A published tool-call timeout and retry behaviour.
- **Actual:** The lifecycle page says it doesn't cover timeouts, retries, tasks or error handling. The CX test page has screen checks but no voice-latency numbers.
- **Severity:** Medium
- **Workaround:** Used 3 s for quick tools and under 30 s per voice reply from [Functional Requirements §7, §9](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html); hard 10 s cap per tool (28 s for an explicit wait); a confirmation token doubles as an idempotency key in case Alexa+ retries.
- **Suggestion:** Publish the client's tool timeout and whether it retries.

## 2026-10-14 · Alexa+ client protocol version doesn't match the hackathon minimum

- **Tool:** Alexa+ MCP Toolkit docs ([Client and App Lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html))
- **Task:** Pick the MCP protocol version for the server.
- **Steps:** Read the hackathon rules (minimum spec 2025-11-25), then the Alexa+ client lifecycle page.
- **Expected:** The Alexa+ client uses 2025-11-25 or later.
- **Actual:** The sample `initialize` uses `2025-03-26` and declares only `roots`. It doesn't declare elicitation or tasks, yet the page says Alexa+ uses elicitation.
- **Severity:** Medium
- **Workaround:** The server supports 2025-11-25 and negotiates down to 2025-03-26. Tasks and elicitation are used only when the client declares them, with tool-based fallbacks otherwise.
- **Suggestion:** State which protocol versions and client capabilities Alexa+ supports today, and make the sample payload match.

## 2026-10-14 · Authentication page contradicts itself on scopes

- **Tool:** Alexa+ MCP Toolkit docs ([Authentication](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html))
- **Task:** Design the token endpoint.
- **Steps:** Read the client credentials requirements, then the runtime flow, Step 5.
- **Expected:** One consistent scope rule.
- **Actual:** The MUST list restricts client-credentials tokens to `mcp:service`. Step 5 says the server issues "`mcp:tools`, `mcp:resource`, or self-defined scope". The page also spells the same scope both `mcp:resource` and `mcp:resources`.
- **Severity:** Low
- **Workaround:** Followed the MUST list: `mcp:service` for client credentials, `mcp:tools` only through authorization code.
- **Suggestion:** Fix Step 5 and use one spelling.

## 2026-10-14 · MCP Design Guide landing page has no rules on it

- **Tool:** Alexa+ docs ([MCP Design Guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-design-guide.html))
- **Task:** Learn the tool and response design rules.
- **Steps:** Opened the design guide from the hackathon resources.
- **Expected:** Concrete rules on tool naming, schemas, response size and display modes.
- **Actual:** The page is an overview and table of contents. The concrete rules turned up in Functional Requirements instead.
- **Severity:** Low
- **Workaround:** Used [Functional Requirements](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) and [Policy Requirements](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html).
- **Suggestion:** Link a one-page checklist from the landing page.

## 2026-10-14 · Supported Capabilities link on the add-ons home page is broken

- **Tool:** Alexa+ docs ([Add-ons home](https://developer.amazon.com/docs/alexaplus/add-ons/home.html))
- **Task:** Find which MCP features Alexa+ supports.
- **Steps:** Clicked "Supported Capabilities" under "Find the proper integration approach".
- **Expected:** The capabilities page.
- **Actual:** The link is malformed (`.add-ons/...`). The working page, reached from the sidebar, only covers authentication and account linking, not protocol features.
- **Severity:** Low
- **Workaround:** Pieced it together from the lifecycle page.
- **Suggestion:** Fix the link and add a protocol-feature support table.

## 2026-10-13 · Amazon Connect is unavailable on AWS India (AISPL) accounts

- **Tool:** Amazon Connect ([instance guide](https://docs.aws.amazon.com/connect/latest/adminguide/amazon-connect-instances.html))
- **Task:** Create a Connect instance for US outbound calls from India.
- **Steps:** Read the instance setup docs before creating one.
- **Expected:** Any AWS account can create an instance in us-east-1 for US numbers.
- **Actual:** Connect "is not available to customers in India using … AWS India". Creating an instance fails for AISPL-billed accounts.
- **Severity:** Blocker for many Indian developers
- **Workaround:** Use an account whose seller of record is Amazon Web Services, Inc.
- **Suggestion:** Mention this on the hackathon Resources page, since the hackathon is open to India.

## 2026-10-13 · Alexa+ add-on tools are partner-only

- **Tool:** Alexa+ MCP Toolkit, Category SDK, Web Simulator
- **Task:** Test the MCP server inside real Alexa+.
- **Steps:** Followed the MCP QuickStart, then read the hackathon FAQ.
- **Expected:** Some hackathon access to the web simulator.
- **Actual:** Available to select partners only, with no way to apply.
- **Severity:** High
- **Workaround:** Built our own web simulator that acts as a real MCP client, as the FAQ allows.
- **Suggestion:** Give hackathon entrants time-boxed simulator access, even read-only.
