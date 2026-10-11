# Agentic mail agent guide

Send mail via transactional plus cold vendors.

## Mental model

A message goes in. Each adapter sends it and returns a receipt.
One core serves all three faces, so each face returns the same shape.

## The three faces

- SDK: `import { sendMail } from "agentic-email"`.
- CLI: `npx agentic-email send --from "..." --to "..." --subject "..." --text "..."`.
- MCP: `npx agentic-email mcp`, then call a tool below.

Keywords: email, resend, cold-email, agentic-suite, claude-code, codex, cli, mcp.

## MCP tools

| Tool | Use it for |
| --- | --- |
| send_mail | Send one mail. Pass dryRun to preview. |
| check_dns | Check SPF, DKIM, and DMARC for a domain. |
| warmup_plan | Build a daily send ramp. |
| warmup_status | Read warmup stats from a cold vendor. |
| stop_campaign | Pause or stop a cold campaign. |
| get_cost_report | Read session cost totals. |

## The loop

1. Discover the tools with `tools/list`.
2. Check DNS for a new sending domain with `check_dns`.
3. Preview a send with `send_mail` and dryRun true.
4. Run the real send when the preview looks right.
5. Read `get_cost_report` and state the cost.

## Rules

- Preview with dry run before each real send.
- Stop when a guard denies the call. State the reason.
- Never retry a denied call with changed text to dodge a guard.
- Report adapter errors as errors. Never present them as success.
- State the cost report before you claim the task is done.
