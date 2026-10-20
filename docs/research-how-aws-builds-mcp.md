# How would Amazon/AWS build CallAssist?

Research report, written 2026-10-21. Deadline: **Fri 23 Oct 2026, 12:00 PT** (handoff target: submit Thu 22 Oct).

Question: if Amazon/AWS engineers got CallAssist's problem, how would they design, build, test, secure and ship it as an Alexa+ add-on MCP server on AWS? What might we miss?

How to read this report:
- Every claim has a URL. A claim marked **(our inference)** is our own conclusion, not a documented fact.
- "CallAssist does it?" was judged by reading the code (`server/src/*.ts`, `server/test/*.ts`), `docs/alexa-plus-design-rules.md`, `handoff/HANDOFF.md` and `FRICTION_LOG.md`. Read-only. Some columns say **Unknown** where the code was not checked in depth.
- This is not legal advice. The compliance section is what a legal review would *ask about*. Ask a lawyer before a real launch.
- Some pages could not be read in full (FCC ruling PDF, `awslabs/mcp` security section). Those gaps are named where they matter.

---

## 1. Summary

Amazon would treat CallAssist as **a tool-calling agent with real-world side effects** (it phones people). That puts it in the "excessive agency" risk class, so the design centres on four ideas:

1. **Small, honest tools.** One customer intent per tool, strict schemas, no overlap, no overclaims.
2. **Human approval that the server enforces,** not one the language model promises. Read back, then explicit "yes", then act.
3. **Real auth and per-user data.** Two OAuth tiers, audience-checked tokens, every record tied to a user.
4. **Calling law as code.** Consent on file, AI disclosure, opt-out, calling hours, retention. Not just a policy page.

Our local build is strong on tool design, consent flags, opt-out, duplicates, emergency redirect and protocol negotiation. The big holes are all "production" items:
- No authentication on `/mcp` or `/agent/mcp`.
- State lives in memory and a JSON file, for a single user.
- No calling-hours check.
- The `confirmed: true` flag is something the model asserts, not something the server can prove.
- Logs include names and message text.
- The docs describe an older tool list (appointments) than the code (tasks, errands).

Section 8 ranks the ten fixes that fit in about 1.5 days.

---

## 2. Working backwards: mini PR/FAQ

Amazon's "working backwards" method starts with a launch press release and an FAQ, written before any code. Sources describe it as a one-page press release plus customer and internal FAQs, and say most PR/FAQs do not get approved, which is intended ([Working Backwards explainer](https://docs.plannotator.ai/frameworks/amazon-working-backwards-prfaq), [Product School](https://productschool.com/blog/product-fundamentals/prfaq); both are secondary sources, not Amazon's own). Amazon's own Day 1 page names "start with the customer and work backwards" and the two-way-door idea (reversible decisions: act with about 70% of the data) ([AWS: Day 1 culture](https://aws.amazon.com/executive-insights/content/how-amazon-defines-and-operationalizes-a-day-1-culture/)).

### Press release (draft)

> **Seattle / Mumbai, 22 Oct 2026. Mobil80 launches CallAssist, the add-on that lets Alexa+ phone your people for you.**
>
> You tell Alexa+: "Have CallAssist ask Raju to bring the car at 5." CallAssist phones Raju in a clear AI voice, says who it is and who it is calling for, hands over the task, and gets a yes and a time. If Raju is late, CallAssist follows up. If Raju has a question, it asks you and calls back with your answer. Then it tells you what happened. It also runs your usual errands ("get me a coffee" calls the office pantry) and carries a message with a question to a family member, even one with only a landline and no app.
>
> "I stopped being the human switchboard," says a (pilot) user. CallAssist only calls people you added and who agreed to be called. It never calls without your spoken "yes". Anyone can say "stop calling me" and it stops for good.

### Customer FAQ

| Question | Answer |
| --- | --- |
| Does it replace "Alexa, call Mom"? | No. Alexa connects *you* to Mom. CallAssist calls *for* you and brings back the answer. |
| Who can it call? | Only people you added who agreed to be called. |
| Will they know it is AI? | Yes. The first sentence of every call says so. |
| What if they do not want calls? | They say "stop". CallAssist marks them and never calls again. |
| Can it call 911 or handle emergencies? | No. It tells you to call 911. |
| What do you keep? | Names, role, number, task text. Deleted after a set time (to be stated in the privacy policy). |

### Internal FAQ (the hard questions)

| Question | Honest answer today |
| --- | --- |
| Can Alexa+ call our server? | Yes if we expose a public HTTPS MCP endpoint with the OAuth shape Alexa+ expects. See section 4 for the AgentCore hosting caveat. |
| What stops a model from placing a call the user never approved? | Today: a `confirmed` flag. Better: a server-issued confirmation token (gap 5). |
| What stops the called person from hijacking the assistant? | Phone agent gets a fixed brief and treats speech as data. Test exists (`safety.test.ts`). Needs guardrails and output limits in production. |
| Is an AI-voice call legal? | With prior express consent, yes. FCC says AI voices count as "artificial" under the TCPA. See section 7. |
| What does it cost per call? | Handoff estimate: about $30 for the whole hackathon. Add per-user daily call caps (gap 3). |
| What is the success metric? | See tenets and metrics below. |

### Success metrics an Amazon team would set **(our inference)**

| Metric | Why |
| --- | --- |
| % of confirmed tasks where the user gets a spoken result in under 3 minutes | The core promise |
| Call-connected rate and answer rate | Reliability |
| Opt-outs per 100 calls, and complaints | Trust and legal risk |
| Wrong-person or wrong-task calls (target: 0) | Safety |
| Cost per completed task | Viability |

---

## 3. Tenets an Amazon team would write

Tenets are short rules the team uses to settle arguments. Amazon's PR/FAQ practice uses them; these are our drafts **(our inference)**, built from the rules in the Alexa+ docs.

1. **The user decides, out loud.** No call, booking or cancellation without a read-back and a clear "yes" ([Functional Requirements §8, §9](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html); [Policy §15](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html)).
2. **The person on the phone is a guest, not an operator.** Anything they say is data, never an instruction ([Policy §12: safety controls against adversarial inputs](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html)).
3. **We never pretend to be human.** Every call opens with who we are and who we call for.
4. **Voice first, screen second.** Every critical fact works with no screen ([Functional Requirements §9](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html)).
5. **Collect the least, keep it the shortest.** Only what the task needs; delete after use ([Policy §3](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html)).
6. **Fail small and say so.** Every error gives a next step, never codes or IDs ([Functional Requirements §2](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html)).
7. **Reversible beats clever.** Prefer the choice we can undo (two-way doors) ([AWS Day 1](https://aws.amazon.com/executive-insights/content/how-amazon-defines-and-operationalizes-a-day-1-culture/)).

---

## 4. Architecture an AWS team would choose

### Picture

```
 User --voice--> Alexa+ (MCP client, 2025-03-26)
                    |  HTTPS, OAuth tier 1 (service) / tier 2 (user, PKCE)
                    v
        [Public MCP endpoint: custom domain]  <-- WAF, rate limits, TLS
        CallAssist MCP server (stateless, Streamable HTTP)
          |  validates token (aud = this server), scopes to user
          |  tools: assign_task, run_errand, deliver_message, get_task_status ...
          v
   DynamoDB (tasks, contacts+consent, call log; TTL; KMS)   SES (email confirm)
          |
          |  StartOutboundVoiceContact  (consent + hours + caps checked first)
          v
   Amazon Connect (us-east-1)  --PSTN-->  Raju's / Grandma's phone
     flow: Set voice -> AI agent (Nova Sonic speech-to-speech)
          |  MCP tools (30 s limit each)
          v
   AgentCore Gateway  -->  phone-agent tools: get_call_brief, report_outcome
          |
          v
   CloudWatch / X-Ray (OpenTelemetry): one correlation ID per errand
```

### Services and why

| Layer | Service | Why an AWS team picks it | Source |
| --- | --- | --- | --- |
| Alexa-facing MCP server | Container or Lambda behind a **custom domain** (ALB/API Gateway, or AgentCore Runtime if the URL and auth fit; see warning below) | Alexa+ needs a stable server URL plus OAuth metadata at that origin | [Auth](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html), [Account linking](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html) |
| Phone-agent tools | **AgentCore Gateway** | It turns Lambda/APIs into MCP tools and does inbound auth. Connect can register a gateway as its MCP tool source | [Gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html), [Connect MCP tools](https://docs.aws.amazon.com/connect/latest/adminguide/ai-agent-mcp-tools.html) |
| Calls and AI voice | **Amazon Connect** + Nova Sonic speech-to-speech | Managed telephony, flow control, one bot setting enables Nova Sonic | [Nova Sonic S2S](https://docs.aws.amazon.com/connect/latest/adminguide/nova-sonic-speech-to-speech.html) |
| Identity | **Cognito** (or any OAuth server meeting the checklist) | Issues both token tiers | [Auth](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html) |
| Data | **DynamoDB** with TTL and KMS | Serverless, per-user partition keys, auto-delete | [Generative AI Lens: security, reliability](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/generative-ai-lens.html) |
| Email confirmation | **SES** | Alexa+ wants a written confirmation channel for bookings | [Policy §14, §15](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html) |
| Monitoring | **CloudWatch + OpenTelemetry (AgentCore Observability)** | Built-in metrics for runtime, gateway, identity; traces need ADOT | [Observability configure](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html), [get started](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-get-started.html) |
| Delivery | **CloudFormation + GitHub Actions OIDC** | Already chosen. cfn-lint and cfn-guard fit it | (project decision, `handoff/HANDOFF.md`) |

### Three facts that change the design

1. **AgentCore Runtime's front door may not suit Alexa+ (our inference, test it).**
   - Runtime serves MCP at a URL that contains the URL-encoded agent ARN, and its inbound auth is a JWT authorizer. When a token is missing it answers 401 with a `WWW-Authenticate` header that points to a metadata API ([AgentCore Runtime MCP](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html)).
   - Alexa+ does not support `WWW-Authenticate` on 401, Dynamic Client Registration or OIDC ([Auth page](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html)). Account linking also wants a metadata document at `/.well-known/oauth-protected-resource` on the server ([Account linking](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html)).
   - So a plain Runtime URL probably cannot satisfy the Alexa+ checklist. A custom domain in front, or hosting the Alexa-facing server elsewhere, is safer. Keep AgentCore Gateway for the *Connect-facing* tools, where its job is clear.
   - Time-box this: 30 minutes with a client that sends Basic-auth `client_credentials` plus a `resource` value.
2. **Connect speaks MCP 2025-03-26 to the Gateway.** The Connect guide says the Gateway's *Supported Versions* must include `2025-03-26`, and the Gateway's `aud` check needs the gateway ID in *Allowed audiences* ([Integrate an MCP server](https://docs.aws.amazon.com/connect/latest/adminguide/3p-apps-mcp-server.html)). A user hit exactly this error (tools never appeared, "Unsupported protocol version: 2025-03-26") ([Classmethod](https://dev.classmethod.jp/articles/amazon-connect-agentcore-gateway-tools-not-displayed/)). Gateway versions are set per gateway and `UpdateGateway` replaces the whole list ([AWS ML blog](https://aws.amazon.com/blogs/machine-learning/how-agentcore-gateway-supports-the-mcp-2026-07-28-spec/)).
3. **Tool calls from Connect time out at 30 seconds** ([Connect MCP tools](https://docs.aws.amazon.com/connect/latest/adminguide/ai-agent-mcp-tools.html)). Phone-agent tools must answer in well under that. `get_call_brief` and `report_outcome` are small and fine.

Also note: a newer MCP spec (2026-07-28) is stateless and drops the `initialize` handshake. Gateway can serve both, but elicitation/sampling tools do not work through the translation for old clients ([AWS ML blog](https://aws.amazon.com/blogs/machine-learning/how-agentcore-gateway-supports-the-mcp-2026-07-28-spec/)). The hackathon asks for 2025-11-25 or later and the Alexa+ client sends 2025-03-26, so we keep the plan: speak 2025-11-25, negotiate down. Our server already runs stateless (`sessionIdGenerator: undefined` in `server/src/app.ts`), which is the mode AgentCore recommends for basic MCP servers ([Runtime MCP](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html)).

---

## 5. Checklists

Legend: **Yes / Partly / No / Unknown** = does CallAssist already do it.

### 5.1 Tool design

| # | Rule | Source | Does it? | What to do |
| --- | --- | --- | --- | --- |
| T1 | One distinct customer intent per tool; no duplicate/overlapping tools | [Tools, schema, data design](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-tools-schema-data-design.html), [FR §13](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Partly.** `find_contact` and `list_team` overlap; so do `get_task_status` and `list_tasks` | Merge or sharpen descriptions so Alexa+ never has to guess |
| T2 | Every tool in `tools/list` works; no placeholders | [FR §13](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Yes** (`protocol.test.ts` lists every tool with schema, title, description) | Keep the test in CI |
| T3 | Valid JSON Schema input; validate before acting | [FR §13](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Yes** (zod schemas, tests for bad args) | None |
| T4 | Output must match a declared schema | [FR §13](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **No.** Tools return `structuredContent` but declare no `outputSchema` | Add `outputSchema` for the shared task view; test that results validate |
| T5 | "Declare only what you honor": no unused parameters | [Tools, schema, data design](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-tools-schema-data-design.html) | **Partly.** `follow_up`, `answer_question` and others accept `taskId` and `person`; check each is used | Remove any parameter that does nothing |
| T6 | No unbounded open-text fields unrelated to purpose; no schema fields unrelated to purpose | [Policy §3](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html) | **Partly.** `task` (400 chars), `message` (300) are on-purpose and length-capped | Keep caps. Explain in the privacy text why free text is needed |
| T7 | Parameter descriptions include synonyms | [FR §13](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Yes** (descriptions list synonyms and examples) | None |
| T8 | Failures use `isError: true` or JSON-RPC errors; input errors as tool errors so the model can self-correct | [FR §13](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html), [MCP 2025-11-25 changelog (SEP-1303)](https://modelcontextprotocol.io/specification/2025-11-25/changelog) | **Yes** (`say(..., isError)`; tests) | None |
| T9 | "Always return something"; empty results become an error with a path forward | [Tools, schema, data design](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-tools-schema-data-design.html) | **Yes** (all not-found paths speak a next step) | None |
| T10 | Stable IDs that chain multi-step flows | [FR §13](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Yes** (`taskId`) | Keep IDs out of speech (already tested) |
| T11 | Read-only vs. mutating hints; AWS's own servers make writes opt-in | [awslabs/mcp README](https://github.com/awslabs/mcp) (write flags like `--allow-write`; the page does not explain them), [DESIGN_GUIDELINES.md](https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md) (silent on annotations) | **Yes** (`readOnlyHint`, `destructiveHint`, `openWorldHint` set) | Mark `assign_task`, `deliver_message`, `run_errand` as `openWorldHint: true` (done); note that hints are advisory, not security |
| T12 | Tool naming: verb-noun, snake_case, letters/digits/underscore, ≤64 chars | [DESIGN_GUIDELINES.md](https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md), [MCP changelog SEP-986](https://modelcontextprotocol.io/specification/2025-11-25/changelog) | **Yes** | None |
| T13 | Docstrings with usage guidance; server-level instructions listing tools | [DESIGN_GUIDELINES.md](https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md) | **Yes** (descriptions + server `instructions`) | Update `instructions` after the tool cleanup |
| T14 | Delegation wording so "call Mom" stays with Alexa | Our own rule in `docs/alexa-plus-design-rules.md` §6b; the FR requirement is "name must not conflict with Alexa commands" ([FR §5](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html)) | **Yes** | None |

### 5.2 Voice UX

| # | Rule | Source | Does it? | What to do |
| --- | --- | --- | --- | --- |
| V1 | Never reference a screen; all critical info by voice | [FR §9](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html), [Test CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html) | **Yes** (speech is plain; `speech` is the same text as `content`) | Add a test that scans all spoken strings for "screen", "tap", "shown" |
| V2 | Read back key details and get an explicit "yes" before commitment | [FR §9](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html), [Policy §15](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html) | **Yes** (two-step `confirmed`) | But see S5: make the "yes" provable |
| V3 | Max 5 options; offer pagination | [FR §9](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Yes** (`slice(0,5)`, "and N more") | None |
| V4 | Voice reply under 30 s; offer "tell more" | [FR §9](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Unknown** | Check longest reply (`list_tasks`, status). About 75 words is roughly 30 s of speech **(our estimate)** |
| V5 | Interim "still working" message for slow calls | [FR §2](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Yes** ("Calling X now…") | Make `get_task_status` default `waitSeconds` 0; do not hold Alexa for 25 s (no Alexa tool timeout is published: [lifecycle page](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html) says it does not cover timeouts) |
| V6 | No API codes, tool names, JSON or IDs spoken; every error has a next step | [FR §2](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Yes** (`safety.test.ts` checks for IDs) | None |
| V7 | Voice and screen never contradict; cards update with voice | [FR §10](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html), [Test CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html) | **Partly.** `structuredContent.speech` equals `content`. No `_meta.ui` yet | Fine for data-only flow. If cards are added, test for matching times and names |
| V8 | Partial input gets a clarifying question; varied phrasings all work; mid-flow correction works | [Test CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html) | **Partly.** Ambiguous person asks "Which?"; `due` parsing is simple | Add 10 phrasing variants per tool to the emulator tests |
| V9 | Do not hand the customer off to a phone, app or website when it could finish in conversation | [Test CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html) | **Partly.** Consent is added "on the CallAssist page" (a web step) | Acceptable for hackathon; note it in the listing. Offer a spoken "ask them to say yes" path later |
| V10 | After an error, Alexa can call again on another path | [Test CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html) | **Yes** (idempotent status; polite failures) | None |
| V11 | Follow-through email: designed, not plain text; details match what was confirmed | [Test CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html) | **No** (no SES yet) | Small HTML email with task, person, time (gap 9) |
| V12 | Health: say "not medical advice" and send emergencies to 911 | [Policy §13](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html) | **Yes** (`EMERGENCY` regex, 911 reply) | Add the short disclaimer line to the listing text |

### 5.3 Security and auth

| # | Rule | Source | Does it? | What to do |
| --- | --- | --- | --- | --- |
| S1 | Token endpoint (tier 1): `client_credentials`, Basic auth, `scope=mcp:service`, `resource` validated, `expires_in` ≤ 3600, no refresh token, no creds in query | [Auth](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html) | **No.** No auth code in the server | Gap 1 |
| S2 | User tier: authorization code + PKCE S256; server metadata lists `S256`; refresh token returned; 401/403 on bad token so Alexa re-links | [Auth](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html), [Account linking](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html), [FR §6](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **No** | Gap 1. Note the pages disagree (tier 1: no refresh token; account linking: refresh token required). Our `FRICTION_LOG.md` should list it |
| S3 | `/.well-known/oauth-protected-resource` with `resource` equal to the manifest URL; static client (no DCR) | [Account linking](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html) | **No** | One JSON route |
| S4 | A service token must never reach user data; scope every record to the token's user | [Auth](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html), [FR §6](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **No.** One global `store.user` and `store.contacts` | Key every DynamoDB item by `userId` from the token |
| S5 | Excessive agency (OWASP LLM06): high-impact actions need approval the model cannot fake | [OWASP LLM Top 10](https://genai.owasp.org/llm-top-10/), [AWS agentic AI security guide](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-security/introduction.html) | **Partly.** `confirmed: true` is a plain boolean the model sets | Return a short-lived `confirmationToken` tied to the exact person+message; `confirmed` requires that token. Use elicitation when the client declares it |
| S6 | Prompt injection through tool results and caller speech (LLM01, LLM05) | [OWASP](https://genai.owasp.org/llm-top-10/), [Policy §12](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html) | **Partly.** `clean()` strips control chars; test "person on the phone can't take over"; brief has rules | Wrap the callee's reply as quoted data with a length cap; never let it set `confirmed`, `person` or `optout` outside the structured outcome enum (already an enum) |
| S7 | Token audience: accept only tokens issued for this server; no token passthrough | [MCP security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) | **No** (no tokens at all) | Check `aud`/`resource` on every request |
| S8 | Do not use sessions for auth; non-guessable session IDs | [MCP security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) | **Yes** (stateless, no session ID) | None |
| S9 | Invalid Origin gets HTTP 403; DNS-rebinding protection | [MCP 2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog) | **Partly.** Foreign `Host` is refused (`protocol.test.ts`); Origin check **Unknown** | Add an Origin allow-list and a test |
| S10 | Phone-agent tools (`/agent/mcp`) need their own auth, never the user's | [MCP security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices), [Connect MCP integration](https://docs.aws.amazon.com/connect/latest/adminguide/3p-apps-mcp-server.html) | **No.** Open endpoint. Anyone who learns a `callId` can call `report_outcome` | On AWS: Gateway JWT, gateway ID in *Allowed audiences*. Locally: shared secret header |
| S11 | Least privilege scopes; no wildcard scopes | [MCP security best practices (scope minimization)](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) | **Unknown** (not built) | Only `mcp:service` and `mcp:tools` |
| S12 | Do not leak internals in errors | [DESIGN_GUIDELINES.md](https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md), [FR §2](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Yes** ("Something went wrong on my side") | None |
| S13 | Secrets: none in repo; Secrets Manager; IAM roles not keys; OIDC deploy | [AWS agentic AI security guide](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-security/introduction.html), `CLAUDE.md` | **Partly** (policy decided, infra not built) | Follow through in CloudFormation |
| S14 | Unbounded consumption (LLM10): rate limits, call caps, budgets | [OWASP](https://genai.owasp.org/llm-top-10/) | **Partly.** `maxActiveCalls`, `maxAttempts: 2`. No per-day or per-user cap | Daily cap per user and per contact (gap 3); AWS Budgets alerts already planned |
| S15 | `/api/state` and similar console endpoints expose phone numbers | OWASP LLM02 sensitive info disclosure ([OWASP](https://genai.owasp.org/llm-top-10/)) | **No.** `publicState()` includes full `phone` | Remove from any internet-facing deploy, or mask to last 2 digits |

### 5.4 Reliability and observability

| # | Rule | Source | Does it? | What to do |
| --- | --- | --- | --- | --- |
| R1 | Stateless MCP for easy scaling on Runtime/Lambda | [Runtime MCP](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html) | **Yes** | None |
| R2 | Durable state outside the process | [Generative AI Lens: Reliability](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/generative-ai-lens.html) | **No.** In-memory `Map` plus a JSON file (`store.ts`) | DynamoDB (gap 5) |
| R3 | Retries and graceful failure | [Generative AI Lens: Reliability](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/generative-ai-lens.html) | **Yes** (2 attempts, delay, "try someone else?") | Make retry state survive restart (needs R2) |
| R4 | Duplicate and double-action protection | [FR §8](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Partly.** `findOpenDuplicate` by normalised text | Add an idempotency key per confirmed request, because Alexa may retry |
| R5 | Tool latency inside 30 s for Connect MCP tools | [Connect MCP tools](https://docs.aws.amazon.com/connect/latest/adminguide/ai-agent-mcp-tools.html) | **Yes** (agent tools are tiny) | Load test with 10 concurrent calls (planned quota) |
| R6 | Search/quick tools answer under 3 s | [FR §7](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Yes** for local; **Unknown** on AWS | Measure p95 after deploy |
| R7 | Log every tool call and response (best practice) | [FR §13](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **Yes** (`wrap()` logs tool, args, ms) | **But** it logs `args` (names, messages): redact before CloudWatch |
| R8 | Structured logs with request IDs and context at service boundaries | [DESIGN_GUIDELINES.md](https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md) | **Partly.** JSON logs; no correlation ID spanning Alexa call, task, Connect contact | Add `correlationId` = `taskId`; pass as Connect contact attribute |
| R9 | Traces and metrics: AgentCore built-in metrics; ADOT for traces | [Observability configure](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html) | **No** | Enable CloudWatch Transaction Search; one dashboard; 3 alarms |
| R10 | Timeouts configurable, with clear error and cleanup | [DESIGN_GUIDELINES.md](https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md) | **Partly.** `waitSeconds` cap 25 | Add a hard server-side timeout per tool |
| R11 | Quotas known and raised early (10 concurrent calls, 2 API req/s) | `handoff/HANDOFF.md` §5 (not independently checked) | **Partly.** `maxActiveCalls` exists | Match it to the real Connect quota |
| R12 | Never delete the Connect stack | `CLAUDE.md` | **Yes** (rule in place) | `DeletionPolicy: Retain` |

### 5.5 Testing

| # | Rule | Source | Does it? | What to do |
| --- | --- | --- | --- | --- |
| X1 | Unit, integration and end-to-end tests in CI; mock AWS | [DESIGN_GUIDELINES.md](https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md) | **Yes** (62 tests; `unit`, `flows`, `protocol`, `safety`, `emulator`) | Add the pipeline step; add a coverage number |
| X2 | Test with MCP Inspector, local then remote | [Runtime MCP appendix](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html) | **Unknown** | One screenshot of Inspector against the deployed URL = evidence for judges |
| X3 | Voice-only pass on the weakest device first; full flow by voice | [FR §3](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html), [Test CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html) | **Partly.** Emulator is rule-based and voice-only | Record the demo voice-only |
| X4 | Varied utterances: full, vague, corrections, out-of-scope | [Test CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html) | **Partly** | Add a table-driven phrasing test |
| X5 | Link, use, unlink, re-link with a different account | [FR §6](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **No** (no linking) | Test two users cannot see each other's tasks |
| X6 | Adversarial input and roleplay exploits | [Policy §12](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html), [OWASP](https://genai.owasp.org/llm-top-10/) | **Yes** (hostile input, takeover, floods) | Add 10 more injection strings from callee speech |
| X7 | Schema conformance of responses | [FR §13](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **No** | Needs T4 |
| X8 | Template checks: cfn-lint, cfn-guard, drift detection | `handoff/HANDOFF.md` §5 | **No** (not built) | In the PR workflow |
| X9 | Well-Architected review of the workload | [Generative AI Lens](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/generative-ai-lens.html) | **No** | Write a one-page self-review in the README |

### 5.6 Compliance (see section 7 for detail)

| # | Rule | Source | Does it? | What to do |
| --- | --- | --- | --- | --- |
| C1 | Prior express consent before an artificial/AI-voice call | [Hunton on FCC ruling](https://huntonak.com/privacy-and-information-security-law/fcc-issues-declaratory-ruling-that-tcpa-applies-to-ai-generated-voice-calls), [47 CFR 64.1200](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200) | **Partly.** Boolean `consent` | Store consent time, source and wording, not just `true` |
| C2 | Say who is calling at the start; give a callback number | [47 CFR 64.1200(b)](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200) | **Partly.** "This is CallAssist, an AI assistant calling for {user}." | Add the legal entity name and a callback number. Ask counsel what name is required |
| C3 | Opt-out honoured; keep the record | [47 CFR 64.1200(a)(10), (b)(3), (d)](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200), [Burr & Forman on revocation](https://www.burr.com/telephone-consumer-protection-act/the-fcc-delays-effective-date-of-tcpa-revoke-all-rule-until-january-31-2027) | **Yes** (`optedOut` forever; persisted; test) | Add a spoken "say stop at any time" and log the timestamp |
| C4 | Calling hours 8 am to 9 pm at the called party's local time | [47 CFR 64.1200(c)(1)](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200) (telephone solicitations; apply it anyway) | **No** | Add `timezone` per contact; block outside 08:00–21:00; speak "I'll call after 8" |
| C5 | Recording: announce or do not record; check all-party-consent states | [Metaverse Law summary](https://www.metaverselaw.com/two-party-consent-requirements-for-recording-calls/) (secondary), [Connect outbound consent blocks](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-connect-customer-input-outbound-calls) | **Unknown** | Turn recording off in the Connect flow; keep transcripts short-lived |
| C6 | No children's data; no emergency claims | [Policy §4, §13](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html) | **Partly.** 911 redirect yes; no check for children's data in free text | Add a refusal for obvious child-data patterns; state in the listing |
| C7 | Privacy Policy and Terms URLs; one-time permission prompt; data disclosure | [Policy §3](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html), [FR §5](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) | **No** (pages not built) | Two static pages with the simulator |
| C8 | Retention: keep data only as long as needed; delete after use | [Policy §3](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html) | **No** (JSON file keeps everything) | DynamoDB TTL (for example 30 days) |
| C9 | Do not collect data about the customer's Alexa environment | [Policy §3](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html) | **Yes** (own contacts list) | None |
| C10 | Written confirmation channel for bookings/transactions | [Policy §14, §15](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html) | **No** (SES not built). CallAssist books nothing today, so this is lower risk | Send an email receipt for tasks anyway: cheap and shows polish |

---

## 6. How AWS builds its own MCP servers (what we can copy)

From the `awslabs/mcp` design guide ([DESIGN_GUIDELINES.md](https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md)):

| Practice | What it says | What it means for us |
| --- | --- | --- |
| One module, one job | Models, tools, constants, API clients in separate files | Our split (`mcp.ts`, `assistant.ts`, `agentMcp.ts`, `telephony.ts`) already fits |
| Typed parameters with descriptions and limits | Every parameter has a description; use min/max length; enums for fixed sets | We do this with zod |
| Put instructions for the calling AI in parameter descriptions | Mark key ones as CRITICAL/IMPORTANT and say why | Add one: "Set confirmed only after the user said yes to the read-back" is there; add why |
| Tool names | ≤64 chars, letters/digits/underscore/hyphen, verb-noun | We comply |
| Docstrings | Purpose, inputs, outputs, usage rules | We comply |
| Server instructions string | List tools and best practice | We have one; update it |
| Errors | Wrap tools; log context; meaningful message | We comply |
| Timeouts | Configurable, with an upper bound, logged | Add a hard cap |
| Logging | Structured, includes request IDs, to stderr | Add IDs; redact |
| Tests | Unit + integration + end-to-end, mock AWS, run in CI | We have tests; add CI |
| Security | Scan code, allow-lists with reasons, no sensitive details in errors | Mostly about code-execution servers; the "do not leak details" part applies |

Gaps in AWS's own guide: it says nothing about tool annotations (read-only/destructive hints). The README shows opt-in write flags, such as `--allow-write` ([awslabs/mcp](https://github.com/awslabs/mcp)). **Lesson:** a hint is advice. IAM and server checks are the real boundary. AWS's own security material says to assume an agent can do anything within its granted entitlements ([AWS agentic AI security guide](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-security/introduction.html), summarised by [secondary coverage](https://agentpedia.codes/blog/aws-mcp-server-secure-iam-guide)).

The AWS agentic-AI security guide says to apply multiple controls of more than one type per threat, and maps its advice to the OWASP LLM Top 10 ([AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-security/introduction.html)). The Generative AI Lens lists "mitigate risks of harmful outputs and excessive agency" and "monitor and audit events" under Security, and "handle failures gracefully" and "implement observability" under Reliability ([Generative AI Lens](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/generative-ai-lens.html)). The Lens is the checklist an AWS reviewer would walk through.

---

## 7. Compliance: what a legal/security reviewer would flag

**Not legal advice. Have counsel check before any real launch. The hackathon demo only calls volunteers who agreed in writing, which is the safest position.**

| Topic | What the rule says | Source | CallAssist position |
| --- | --- | --- | --- |
| AI voice = "artificial" voice | FCC declaratory ruling of 8 Feb 2024: voices made by AI count as artificial under the TCPA, so prior express consent is needed unless an exemption applies. Some firms warn that "illegal" overstates it: these calls are allowed, with conditions | [Hunton](https://huntonak.com/privacy-and-information-security-law/fcc-issues-declaratory-ruling-that-tcpa-applies-to-ai-generated-voice-calls), [Cooley](https://cooley.com/news/insight/2024/2024-02-15-fcc-ai-generated-robocalls-illegal-under-the-tcpa), [Akin Gump](https://www.akingump.com/en/insights/ai-law-and-regulation-tracker/fcc-issues-declaratory-ruling-on-ai-generated-voice-robocalls). The FCC order PDF itself could not be read here | Consent flag exists; make it a dated record |
| Calls to mobile numbers | Artificial/prerecorded voice to cellular numbers needs prior express consent; marketing calls need *written* consent | [47 CFR 64.1200(a)(1)(iii), (a)(2)](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200) | CallAssist's calls are informational (a task, a message), not marketing. Keep it that way; no upsell in any call |
| Identify the caller | At the start, name the responsible business (the registered name for businesses); give a callback number during or after | [47 CFR 64.1200(b)(1), (b)(2)](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200) | Disclosure line names "CallAssist" and the user. Confirm the legal entity name (handoff says "Mobil80 Solutions" is not yet confirmed) and add a callback number |
| Opt-out | Automated, voice- or key-activated opt-out within 2 seconds of the ID for telemarketing and certain other calls; consent can be revoked by reasonable means; honour within a reasonable time, no more than 10 business days; keep records 5 years | [47 CFR 64.1200(a)(10), (b)(3), (d)(3), (d)(6)](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200) | Opt-out is instant and permanent (tested). Add timestamp log. "Revoke-all" part of the FCC revocation rule is delayed to 31 Jan 2027 ([Burr & Forman](https://www.burr.com/telephone-consumer-protection-act/the-fcc-delays-effective-date-of-tcpa-revoke-all-rule-until-january-31-2027)); check status before launch |
| Calling hours | No telephone *solicitation* to residential numbers before 8 am or after 9 pm at the called party's local time | [47 CFR 64.1200(c)(1)](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200) | Not legally aimed at non-marketing calls, but a reviewer would still expect it. **No quiet-hours check in code** |
| Do-not-call | Internal DNC list: written policy, training, honour requests, keep 5 years | [47 CFR 64.1200(d)](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200) | Opt-out list is our internal DNC. Add a one-paragraph written policy |
| Recording | Several US states need all-party consent to record. Announcing and continuing is often treated as consent. Use the strictest rule when states differ | [Metaverse Law](https://www.metaverselaw.com/two-party-consent-requirements-for-recording-calls/) (secondary source, no statute text) | Best: **do not record**. Connect can collect consent by keypad/Lex on outbound flows if recording is needed ([AWS What's New](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-connect-customer-input-outbound-calls)) |
| Alexa+ platform rules | No children's data; no emergency/life-saving claims; privacy URLs; one-time permission prompt | [Policy §3, §4, §13](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html) | See C6, C7 |

---

## 8. Top 10 gaps to fix before Fri 23 Oct 12:00 PT

Ranked by judging impact, and sized for about 1.5 days. Gaps 1 to 3 are what a judge reading the repo will notice first.

| Rank | Gap | Why it matters (judging) | Fix | Size |
| --- | --- | --- | --- | --- |
| 1 | **No auth on `/mcp` and `/agent/mcp`** (S1, S2, S3, S7, S10) | Tech score; it is on Amazon's own MUST list; "MCP actually works with Alexa+" is the pass/fail screen | Minimal OAuth in the server: `/token` for `client_credentials` (Basic auth, `resource` check, `mcp:service`, 3600 s, no refresh), protected-resource metadata route, bearer check, 401 on bad token. Shared-secret header for `/agent/mcp`. Cognito can replace it later | 4–6 h |
| 2 | **Where the server lives is unproven for Alexa+** (section 4, fact 1) | A demo that cannot be reached from a real MCP client fails the pass/fail screen | 30-minute test: public HTTPS endpoint with custom domain, Basic-auth `client_credentials`, Inspector against it. If AgentCore Runtime fails, host behind ALB/API Gateway. Add `2025-03-26` to the Gateway's supported versions | 1–2 h |
| 3 | **No calling-hours check, no daily cap, thin consent record** (C1, C4, S14) | Impact + trust; reviewers know TCPA; shows "calling law as code" | Per-contact `timezone`, block outside 08:00–21:00 with a spoken reason; per-user and per-contact daily call caps; store consent time, source, text; add callback number and entity name to the disclosure line; spoken "say stop any time" | 3–4 h |
| 4 | **`confirmed: true` is model-asserted** (S5, OWASP LLM06) | Design and Tech; the most reviewable "safe agent" point | First call returns `confirmationToken` (random, 5-minute TTL, bound to person+message+user); second call needs it. Idempotency key stops Alexa retries from double-calling (R4). Test: forged `confirmed:true` with no token fails | 2–3 h |
| 5 | **State in memory/JSON, one global user** (R2, S4, C8) | Tech: "production on AWS" story and data-leak rule | DynamoDB tables keyed by `userId`, TTL 30 days, KMS; same store interface so tests still pass. Test: user A cannot read user B | 4–6 h |
| 6 | **Logs contain names, numbers, message text** (R7, S15, OWASP LLM02) | Tech/Impact: privacy claims must match behaviour | Redact `args` to field names and lengths; mask phone numbers in `publicState`; no transcript text in CloudWatch beyond a short TTL; recording off in the Connect flow | 1–2 h |
| 7 | **Observability story missing** (R8, R9) | Tech: easy, visible win in the video | `correlationId` = `taskId` across tool call, call record and Connect contact attribute; CloudWatch dashboard (calls started, answered, opt-outs, tool p95) and 3 alarms; Transaction Search on | 2–3 h |
| 8 | **Tool surface not final; no `outputSchema`; docs stale** (T1, T4, T5, T14; docs describe `find_providers`, `book_appointment` which the code no longer has) | Design: a judge comparing docs to code loses trust | Merge overlapping tools; add `outputSchema`; update `docs/alexa-plus-design-rules.md` and the Alexa-facing instructions to the real tool list; add 3+ example phrases | 2–3 h |
| 9 | **Listing and policy assets missing** (C6, C7, V11, C10) | Idea/Impact polish; Alexa+ FR §5 and Policy §3 require them | Privacy Policy and Terms pages (retention 30 days, data collected, no children's data, "not medical advice", "for emergencies call 911"); icon; SES email receipt; one-time permission text | 3–4 h |
| 10 | **Evidence of testing and friction log not published** (X1, X2, X8, friction log) | Tech and the up-to-10% friction-log bonus | CI workflow running `npm test` and `tsc`; Inspector screenshot against the deployed URL; 10 more injection and phrasing tests; a short "test report" in the README. Add the friction entries listed below | 2–3 h |

Fast order if time is short: 2 (prove it is reachable) → 1 → 4 → 3 → 6 → 8 → 7 → 5 → 9 → 10. Gap 5 can be partly cut: a DynamoDB-backed store for tasks and contacts only is enough.

### Friction log candidates (add to `FRICTION_LOG.md` in the existing format)

These came up during this research; each has a source:

1. **Connect's MCP client asks the Gateway for 2025-03-26, which a new gateway may not accept.** Tools do not appear in Connect with no clear error ([Connect guide](https://docs.aws.amazon.com/connect/latest/adminguide/3p-apps-mcp-server.html), [Classmethod](https://dev.classmethod.jp/articles/amazon-connect-agentcore-gateway-tools-not-displayed/)). Suggestion: make `2025-03-26` a default, or show a clear warning.
2. **Alexa+ docs disagree on refresh tokens.** Tier 1 says no refresh token; account linking says the endpoint must return one ([Auth](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html), [Account linking](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html)). They are different grants, so the fix is a one-line clarification. Also: 401 vs 401/403 for re-link.
3. **AgentCore Runtime's built-in auth style (401 + `WWW-Authenticate`, long ARN URL) does not match what Alexa+ supports** (our inference; confirm with the test in gap 2) ([Runtime MCP](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html), [Auth](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html)).
4. **The Alexa+ lifecycle page says it does not cover timeouts, retries, tasks or error handling** ([lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html)). We could not design the latency budget from docs; we used 3 s (search) and 30 s (voice reply) from [Functional Requirements §7, §9](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html).
5. **Test CX page has pass/fail checks for screens but no voice-latency numbers** ([Test CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html)).

---

## 9. Judging angle

The scoring model comes from `handoff/HANDOFF.md` §2 (from the Devpost rules at https://amazonappdev2026.devpost.com/, **not re-checked in this research**): a pass/fail screen (fits the Alexa+ track; really uses MCP in code), then four equal criteria scored 1 to 5 (Tech, Design, Impact, Idea), plus a friction log worth up to 10%.

| Criterion | What judges likely look for | What CallAssist shows now | What this report says to add |
| --- | --- | --- | --- |
| **MCP pass/fail** | A real MCP server, spec 2025-11-25+, Streamable HTTP, a real client calls it | Yes: SDK 1.32, negotiates 2025-03-26 and 2025-11-25, a real MCP client in the emulator, tests | Prove it from outside: Inspector against the deployed URL (gap 2, 10) |
| **Tech** | Auth, data, observability, IaC, CI, tests, AWS depth | Strong tests; good protocol work; planned CloudFormation, OIDC, Connect, Nova Sonic, AgentCore Gateway | Auth (1), durable state (5), correlation IDs and dashboard (7), CI (10) |
| **Design** | Voice-first UX, confirmation, error handling, matches Alexa+ rules | Strong: read-back, no screen references, no IDs in speech, polite errors, delegation wording | Provable confirmation (4), tool cleanup and output schemas (8) |
| **Impact** | A real person's problem, safe and legal | Busy caregivers/managers; consent, opt-out, 911 redirect, no children's data | Calling hours and caps (3), privacy pages and retention (9) |
| **Idea** | Fresh, clear, not already built into Alexa | "Alexa calls *for* you" and brings the answer back, including to landlines; clear contrast with "call Mom" | A one-line PR/FAQ in the video: customer, problem, outcome (section 2) |
| **Friction log (up to 10%)** | Specific, reproducible, with suggestions | 6 good entries | 5 more above, each with source and workaround |

**Video angle (2:50):** show one thing an Amazon reviewer would respect: "Alexa asks for a yes; the server checks the yes." Then show the consent/opt-out and the hours block. Those are the moments that separate a demo from a product.

---

## 10. What we might miss (short list)

1. **The hosting/auth mismatch** (section 4, fact 1). Most likely hidden blocker.
2. **`confirmed` can be forged by a model.** Looks safe in tests, is not safe by design.
3. **Data and logs leak by default.** Phone numbers in a state API and message text in logs.
4. **Time zones.** Raju in Mumbai and the user in Seattle: "8 am to 9 pm" is the *called party's* local time, not the server's.
5. **Legal entity name on the call** and a **callback number.**
6. **Alexa+ may retry a tool call.** Without an idempotency key, one "yes" can place two calls.
7. **Docs/code drift.** The design-rules doc still lists appointment tools. Reviewers read docs first.
8. **Recording by default.** Check the Connect flow does not record; some states need all-party consent.
9. **Cost.** A loop or a retry storm is a bill. Daily caps and Budgets alerts before the demo.
10. **Children's data in free text.** The Alexa+ policy rejects add-ons that collect it; our `task` field is free text.

---

## Source index

Alexa+ docs: [Functional Requirements](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html) · [Policy Requirements](https://developer.amazon.com/docs/alexaplus/add-ons/policy-requirements.html) · [Design Guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-design-guide.html) · [Conversation surface](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-conversation-surface.html) · [Tools, schema, data design](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-tools-schema-data-design.html) · [Test your add-on CX](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-test-addon-cx.html) · [Client lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html) · [Authentication](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html) · [Account linking](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html)

AWS: [AgentCore Runtime MCP](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html) · [AgentCore Gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html) · [AgentCore Observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html) · [Connect MCP tools](https://docs.aws.amazon.com/connect/latest/adminguide/ai-agent-mcp-tools.html) · [Integrate an MCP server with Connect](https://docs.aws.amazon.com/connect/latest/adminguide/3p-apps-mcp-server.html) · [Nova Sonic speech-to-speech](https://docs.aws.amazon.com/connect/latest/adminguide/nova-sonic-speech-to-speech.html) · [Connect outbound consent input](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-connect-customer-input-outbound-calls) · [Gateway and MCP 2026-07-28](https://aws.amazon.com/blogs/machine-learning/how-agentcore-gateway-supports-the-mcp-2026-07-28-spec/) · [Generative AI Lens](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/generative-ai-lens.html) · [Security for agentic AI](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-security/introduction.html) · [awslabs/mcp](https://github.com/awslabs/mcp) · [DESIGN_GUIDELINES.md](https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md) · [AWS Day 1 culture](https://aws.amazon.com/executive-insights/content/how-amazon-defines-and-operationalizes-a-day-1-culture/)

MCP and security: [Security best practices (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) · [Changelog (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/changelog) · [OWASP LLM Top 10](https://genai.owasp.org/llm-top-10/)

Law (secondary sources are marked in the text): [47 CFR 64.1200](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200) · [Hunton](https://huntonak.com/privacy-and-information-security-law/fcc-issues-declaratory-ruling-that-tcpa-applies-to-ai-generated-voice-calls) · [Cooley](https://cooley.com/news/insight/2024/2024-02-15-fcc-ai-generated-robocalls-illegal-under-the-tcpa) · [Akin Gump](https://www.akingump.com/en/insights/ai-law-and-regulation-tracker/fcc-issues-declaratory-ruling-on-ai-generated-voice-robocalls) · [Burr & Forman](https://www.burr.com/telephone-consumer-protection-act/the-fcc-delays-effective-date-of-tcpa-revoke-all-rule-until-january-31-2027) · [Metaverse Law](https://www.metaverselaw.com/two-party-consent-requirements-for-recording-calls/)

Other: [Classmethod (Connect + Gateway protocol error)](https://dev.classmethod.jp/articles/amazon-connect-agentcore-gateway-tools-not-displayed/) · [Working Backwards explainer](https://docs.plannotator.ai/frameworks/amazon-working-backwards-prfaq) · [Product School PR/FAQ](https://productschool.com/blog/product-fundamentals/prfaq) · [agentpedia (secondary)](https://agentpedia.codes/blog/aws-mcp-server-secure-iam-guide)

Not independently verified: the Devpost rules and the handoff's cost/quota numbers (taken from `handoff/HANDOFF.md`); the full text of the FCC Feb 2024 order; whether Cognito validates the RFC 8707 `resource` parameter (still open in the handoff).
