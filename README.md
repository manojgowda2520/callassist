# Legwork: an Alexa+ MCP server that makes the phone calls

Ask Alexa+ for an appointment. Legwork phones the top 3 nearby businesses, asks each for its price and next open slot, reports back, and books the one you choose.

> Status: in development for the Amazon "Build, Ship, Shape" hackathon (Alexa+ track, plus the AWS Builder and Open Source mini challenges).

## How it works

1. **Find.** `find_providers` picks the 3 best-rated businesses nearby that are open when you need them.
2. **Call.** `request_quotes` starts real phone calls through Amazon Connect. A Nova Sonic voice agent says it's an AI, asks for price and availability, and reports back through MCP tools on Amazon Bedrock AgentCore Gateway.
3. **Report.** `get_quotes` returns each office's answer.
4. **Book.** `book_appointment` reads the details back, waits for your explicit "yes", calls the business to book, and emails a confirmation.

## Built with

- MCP spec 2025-11-25 over Streamable HTTP, negotiating down to 2025-03-26 for the documented Alexa+ client
- Amazon Connect: outbound calls, a Conversational AI bot with Nova Sonic speech-to-speech, and an AI agent
- Amazon Bedrock AgentCore: Runtime for the MCP server, Gateway for the phone agent's tools
- AWS Lambda, Amazon DynamoDB, Amazon Cognito, Amazon SES
- AWS CloudFormation, deployed by GitHub Actions with OIDC
- Google Places API (New)

## Docs

- [Alexa+ design rules and how Legwork follows them](docs/alexa-plus-design-rules.md)
- [Friction log](FRICTION_LOG.md)

## License

MIT. See [LICENSE](LICENSE).
