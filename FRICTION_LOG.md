# Friction log

Entries use the format the hackathon asks for: task, steps, expected vs. actual, severity, workaround, suggestion. Newest first.

Severity: **Blocker** (can't proceed), **High** (big detour), **Medium** (slows down), **Low** (annoyance).

---

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
