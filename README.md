# agentic-inbox

[![npm version](https://img.shields.io/npm/v/agentic-inbox)](https://www.npmjs.com/package/agentic-inbox) [![Downloads/month](https://img.shields.io/npm/dm/agentic-inbox)](https://www.npmjs.com/package/agentic-inbox) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package and API types](https://www.npmjs.com/package/agentic-inbox)

agentic-inbox is an open-source email adapter package for developers sending transactional email and adding leads to cold-email campaigns.

## Install

```sh
npm install agentic-inbox
```

Requires Node.js 18 or later. Includes TypeScript types and three direct runtime dependencies.

## Preview your first email

```js
import { sendMail, ResendAdapter, getCostReport } from "agentic-inbox";
const message = {
  from: "you@example.com", to: ["friend@example.com"],
  subject: "Hi", text: "Hello",
};
console.log(await sendMail(message, { adapters: [new ResendAdapter()] }));
console.log(getCostReport());
```

Success prints `dryRun: true`, the recipient, and `adapters: ["resend"]`. No key is needed; no email is sent.
Export provider keys in your shell; the package does not load `.env` files.

```sh
export RESEND_API_KEY="your-key"
npx agentic-inbox send --adapter resend --from you@your-domain.com --to friend@example.com --subject Hi --text Hello --live
```

Use a provider-approved sender. Success prints `ok: true` and a receipt ID; this confirms API acceptance, not inbox delivery.

## How it works

```text
SDK / CLI / MCP -> validation + optional guards -> preview OR selected adapters
```

## Provider coverage

| Provider | Implemented operation | Environment variables |
| --- | --- | --- |
| Resend | Send email | `RESEND_API_KEY` |
| Postmark | Send email | `POSTMARK_SERVER_TOKEN` |
| Instantly | Add campaign lead, warmup analytics, pause campaign | `INSTANTLY_API_KEY`, `INSTANTLY_CAMPAIGN_ID` |
| Smartlead | Import campaign lead, warmup stats, campaign status | `SMARTLEAD_API_KEY`, `SMARTLEAD_CAMPAIGN_ID` |

All four adapters implement HTTP requests. Live credential verification is pending in this README review.
Pass campaign IDs through constructor options or CLI `--campaign` to override environment values.

## Features and runtime surfaces

- CLI: `send`, `dns`, `warmup plan`, `warmup status`, `stop`, `costs`, `mcp`; `--help` and `--version` print metadata.
- Model Context Protocol (MCP): `send_mail`, `check_dns`, `warmup_plan`, `warmup_status`, `stop_campaign`, `get_cost_report`.
- Start the stdio server with `npx agentic-inbox mcp`. Sending previews by default; SDK live sends require `dryRun: false`.
- Check Sender Policy Framework (SPF), DomainKeys Identified Mail (DKIM), and Domain-based Message Authentication, Reporting, and Conformance (DMARC) records.
- Run `npx agentic-inbox dns --domain example.com --selector s1`; DNS checks require the correct DKIM selector.
- Run `npx agentic-inbox warmup plan --days 3` for a send ramp. The plan does not execute warmup.
- Resend and Postmark attach one-click unsubscribe headers when `unsubscribeUrl` is set; you must implement the unsubscribe endpoint.

## Behavior limits and status

Live sends fan out to every selected adapter; the CLI and MCP default to all four. Select adapters explicitly to limit dispatch.
Instantly and Smartlead queue only the first recipient. They do not forward subject, body, or unsubscribe headers.
Adapter requests default to a 10-second timeout without automatic retries. Each live result reports its own success or error.
Costs count recipient units, not currency, and remain process-local. Read `getCostReport()` within the sending process.
DNS record presence does not prove deliverability. This package provides no managed email service or inbox reader.
The repository Worker implements health, preview, and warmup-plan routes only; it cannot send email.
Version 0.1.0 APIs can change. Support uses repository issues; access may require repository permissions.

## Contributing and license

Preview each send first, report guard denials, and read the session cost report after live work.
Run `npm run build && npm run typecheck && npm test` before pushing. The `release` branch publishes new versions.
License: MIT.
