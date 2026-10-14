# Friction log

Entries use the format the hackathon asks for: task, steps, expected vs. actual, severity, workaround, suggestion. Newest first.

Severity: **Blocker** (can't proceed), **High** (big detour), **Medium** (slows down), **Low** (annoyance).

---

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
