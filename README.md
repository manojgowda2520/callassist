# CallAssist: an Alexa+ MCP server that makes your phone calls

CallAssist is an AI that makes phone calls for you. You ask Alexa+, and CallAssist does one of two jobs:

- **Books appointments.** It calls the top 3 nearby businesses at once, asks each for its price and next open slot, reports back, and books the one you choose.
- **Passes messages.** It calls someone from your trusted contacts, delivers your message, and brings back their reply.

> Status: in development for the Amazon "Build, Ship, Shape" hackathon (Alexa+ track, plus the AWS Builder and Open Source mini challenges).

## Examples

> "Alexa, find me an OB/GYN who can see me this week, in-network with Aetna."
> "Alexa, book the Thursday one."
> "Alexa, tell Grandma I'll pick her up at 5, and ask if she needs anything from the store."

## How it works

1. **Find.** `find_providers` picks the 3 best-rated businesses nearby that are open when you need them. `find_contact` looks up a person in your trusted contacts.
2. **Call.** `request_quotes` or `call_contact` starts real phone calls through Amazon Connect. A Nova Sonic voice agent says it's an AI, does the job, and reports back through MCP tools on Amazon Bedrock AgentCore Gateway.
3. **Report.** `get_call_status` returns each call's result: a quote, a booking or a reply.
4. **Book.** `book_appointment` reads the details back, waits for your explicit "yes", calls the business to book, and emails a confirmation. `reschedule_appointment` and `cancel_appointment` work the same way.

Nothing is booked, and no one is called, without your "yes". Only contacts you've added and who agreed to it are ever called.

## Built with

- MCP spec 2025-11-25 over Streamable HTTP, negotiating down to 2025-03-26 for the documented Alexa+ client
- Amazon Connect: outbound calls, a Conversational AI bot with Nova Sonic speech-to-speech, and an AI agent
- Amazon Bedrock AgentCore: Runtime for the MCP server, Gateway for the phone agent's tools
- AWS Lambda, Amazon DynamoDB, Amazon Cognito, Amazon SES
- AWS CloudFormation, deployed by GitHub Actions with OIDC
- Google Places API (New)

## Docs

- [Alexa+ design rules and how CallAssist follows them](docs/alexa-plus-design-rules.md)
- [Calling by region: Amazon Connect for the US, a SIP trunk for India](docs/telephony-regions.md)
- [Friction log](FRICTION_LOG.md)

## License

MIT. See [LICENSE](LICENSE).
