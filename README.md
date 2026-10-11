# Agentic mail

Send mail via transactional plus cold vendors.

Send a receipt after checkout.
Confirm a new address with a link.
Queue a follow-up note for a prospect.

## Start

Use Node 18 or later. Install and check the pack:

```sh
npm install
npm run build
npm run typecheck
npm test
node dist/cli.js --help
node dist/cli.js send --from you@example.com --to friend@example.com --subject "Hi" --text "Hello"
node dist/cli.js dns --domain example.com
node dist/cli.js warmup plan --days 3
node dist/cli.js costs
```

Send defaults to a dry run. It calls no vendor and records no cost.
Add `--live` to send for real. Each adapter reports its own result.
A failed adapter causes CLI exit 1. Bad usage exits 2.
Cost entries count mails, not currency.
Reports stay in the current process and reset when it exits.

## Adapters

| Adapter | Setup | Sends through |
| --- | --- | --- |
| resend | RESEND_API_KEY | Resend email API |
| postmark | POSTMARK_SERVER_TOKEN | Postmark email API |
| instantly | INSTANTLY_API_KEY plus campaign | Instantly campaign lead |
| smartlead | SMARTLEAD_API_KEY plus campaign | Smartlead campaign lead |

Keys also accept `apiKey` in adapter constructors.
Network adapters accept `fetchFn` and `timeoutMs`.
Cold adapters need a campaign id. Pass `--campaign` or set
INSTANTLY_CAMPAIGN_ID or SMARTLEAD_CAMPAIGN_ID in the environment.
Cold adapters queue the first recipient as a campaign lead.
Select adapters with `--adapter`, or use `all`.

## SDK

```js
import { sendMail, ResendAdapter } from "agentic-email";

const preview = await sendMail(
  { from: "you@example.com", to: ["friend@example.com"], subject: "Hi", text: "Hello" },
  { adapters: [new ResendAdapter()], dryRun: true },
);
console.log(preview);
```

sendMail accepts adapters, guards, logger, and dryRun.
It checks guards before any adapter call and fans out live sends.
Each live adapter call records a send entry, including zero units on failure.
Dry run is the default. Pass `dryRun: false` to send for real.

## MCP

Start the server with `agentic-email mcp` or `npx agentic-email mcp`.

| Tool | Use it for |
| --- | --- |
| send_mail | Send one mail. Dry run is the default. |
| check_dns | Check SPF, DKIM, and DMARC for a domain. |
| warmup_plan | Build a daily send ramp. |
| warmup_status | Read warmup stats from a cold vendor. |
| stop_campaign | Pause or stop a cold campaign. |
| get_cost_report | Read session cost totals. |

## Deliverability

Check DNS before you send from a new domain:

```sh
node dist/cli.js dns --domain example.com --selector s1
```

The report shows SPF, DKIM, and DMARC records.
Warm a new mailbox with a ramp:

```sh
node dist/cli.js warmup plan --start 10 --step 10 --max 100 --days 14
```

Read vendor warmup stats with `warmup status`.
Bulk mail carries one-click stop headers when you pass `--unsubscribe-url`.
Stop a cold campaign with `stop --vendor smartlead --campaign 123`.

## Rules

- Preview each send with a dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.

## Docs

- Core contract: https://github.com/pooriaarab/agentic-email/blob/main/docs/agentic-core.md
- License: MIT
