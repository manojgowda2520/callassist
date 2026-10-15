# Calling by region

CallAssist picks the phone line by the destination number's country:

- **US numbers (+1)** go through **Amazon Connect** in us-east-1. This is the only path built for the hackathon.
- **India numbers (+91)** go through **Mobil80's Asterisk server and its Airtel SIP trunk**. This path is planned for after the hackathon.

Proposed 2026-10-15.

## Why two paths

- Amazon Connect is not available to AWS India (AISPL) accounts.
- Connect places calls over AWS's own telephony, so a company SIP trunk can't be used as its carrier in the standard setup.
- Mobil80 already runs Asterisk with an Airtel SIP trunk for Indian calls.

So the India path uses Asterisk, with our own audio bridge to Nova Sonic.

## How a call is routed

```
CallAssist MCP server
  └── call router: looks at the destination number
        ├── +1  → ConnectProvider  → StartOutboundVoiceContact → Connect AI agent (Nova Sonic)
        └── +91 → SipProvider      → Asterisk originate (Airtel SIP)
                                       → AudioSocket → bridge service → Nova 2 Sonic on Bedrock
```

Both providers share everything above the phone line:

- The same errand records in DynamoDB
- The same call brief, with modes `inquiry`, `booking` and `message`
- The same report tools: `report_quote`, `report_booking`, `report_reply`
- The same rules: AI disclosure first, trusted contacts only, opt-out, a "yes" before any call

## Hackathon build (Oct 15–22)

- Only `ConnectProvider` is implemented. US numbers and US English only, with volunteer "trusted contacts".
- The call router and a `TelephonyProvider` interface exist in code from day 1, so the India path plugs in later without changing the tools.
- The write-up describes the India path as the next step.

## India path, after the hackathon

| Piece | Plan |
| --- | --- |
| Dialing | Asterisk originates through ARI or AMI on the existing Airtel trunk. Calls go only to trusted contacts who agreed |
| Audio | Asterisk AudioSocket streams call audio to a small bridge service |
| Voice AI | The bridge holds a bidirectional stream to Nova 2 Sonic on Bedrock. Nova 2 Sonic runs in us-east-1, us-west-2 and ap-northeast-1 (Tokyo); Tokyo is the closest to India |
| Tools | Nova 2 Sonic tool calls go to the same report Lambdas |
| Language | Check Nova 2 Sonic's support for Hindi and Indian English before building |
| Where it runs | The bridge runs as a container next to the Asterisk server, or in ap-south-1 |

## Before the India path is built

- **Approval.** The approval form said no company SIP trunks would be used. Using the Airtel trunk needs a separate OK from the manager.
- **Indian telecom rules.** Automated or AI calls over an enterprise SIP trunk fall under TRAI and DoT rules. Review this with whoever handles compliance for Mobil80's existing voice campaigns.
- **Client.** Alexa+ isn't available in India yet. Indian users would reach CallAssist through our web app, another MCP client, or a classic Alexa skill.
