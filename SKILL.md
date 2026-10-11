---
name: agentic-inbox
description: Send mail via transactional plus cold vendors. Keywords: email, resend, cold-email, agentic-suite, claude-code, codex, cli, mcp.
---

# agentic-inbox

Send mail via transactional plus cold vendors.

## Use the SDK

```js
import { sendMail, ResendAdapter } from "agentic-inbox";

await sendMail(
  { from: "you@example.com", to: ["friend@example.com"], subject: "Hi", text: "Hello" },
  { adapters: [new ResendAdapter()], dryRun: true },
);
```

## Use the CLI

```sh
agentic-inbox send --from you@example.com --to friend@example.com --subject "Hi" --text "Hello"
agentic-inbox dns --domain example.com
```

## Use the MCP server

Start the server with `agentic-inbox mcp`. Call `send_mail`
to send, `check_dns` for records, `get_cost_report` for costs.

## Rules

- Preview each send with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
