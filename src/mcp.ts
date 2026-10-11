import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createLogger,
  getCostReport,
  GuardError,
  VendorError,
  type Guards,
  type Logger,
} from "./core.js";
import { DEFAULT_BRAND } from "./index.js";
import {
  buildWarmupPlan,
  checkDns,
  defaultAdapters,
  InstantlyAdapter,
  sendMail,
  SmartleadAdapter,
  type DnsOptions,
  type MailAdapter,
  type MailMessage,
  type SmartleadStatus,
} from "./mail.js";

export interface McpDeps {
  adapters?: MailAdapter[];
  guards?: Guards;
  logger?: Logger;
  resolveFn?: DnsOptions["resolveFn"];
  instantly?: InstantlyAdapter;
  smartlead?: SmartleadAdapter;
}

const messageShape = {
  from: z.string().describe("Sender email address."),
  to: z.array(z.string()).describe("Recipient email addresses."),
  subject: z.string().describe("Email subject."),
  html: z.string().optional().describe("HTML body."),
  text: z.string().optional().describe("Plain text body."),
};

function errorResult(error: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function okResult(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const logger = deps.logger ?? createLogger({ quiet: true });
  const guards = deps.guards;
  const resolveFn = deps.resolveFn;
  const instantly = deps.instantly ?? new InstantlyAdapter();
  const smartlead = deps.smartlead ?? new SmartleadAdapter();
  const server = new McpServer({
    name: DEFAULT_BRAND.command,
    version: DEFAULT_BRAND.version,
  });

  server.registerTool(
    "send_mail",
    {
      description: "Send one mail through mail adapters. Dry run is the default.",
      inputSchema: {
        ...messageShape,
        adapters: z
          .array(z.string())
          .optional()
          .describe("Adapter names, or all. Default: all."),
        campaignId: z.string().optional().describe("Cold campaign id for cold adapters."),
        dryRun: z.boolean().optional().describe("Preview without sending. Default: true."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ from, to, subject, html, text, adapters, campaignId, dryRun }) => {
      try {
        const message: MailMessage = { from, to, subject, html, text };
        const picked = deps.adapters ?? defaultAdapters({ campaignId });
        const names = adapters ?? ["all"];
        const selected =
          names.includes("all")
            ? picked
            : names.map((name) => {
                const found = picked.find((adapter) => adapter.name === name);
                if (!found) throw new VendorError(`mail: unknown adapter "${name}"`);
                return found;
              });
        return okResult(
          await sendMail(message, { adapters: selected, guards, logger, dryRun: dryRun ?? true }),
        );
      } catch (error) {
        if (error instanceof GuardError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "check_dns",
    {
      description: "Check SPF, DKIM, and DMARC records for a domain.",
      inputSchema: {
        domain: z.string().describe("Domain to check, like example.com."),
        selector: z.string().optional().describe("DKIM selector."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ domain, selector }) => {
      try {
        return okResult(await checkDns(domain, { selector, resolveFn }));
      } catch (error) {
        if (error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "warmup_plan",
    {
      description: "Build a daily send ramp for a warming mailbox.",
      inputSchema: {
        startPerDay: z.number().optional().describe("Day one sends. Default: 10."),
        stepPerDay: z.number().optional().describe("Daily rise. Default: 10."),
        maxPerDay: z.number().optional().describe("Daily cap. Default: 100."),
        days: z.number().optional().describe("Plan length. Default: 14."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ startPerDay, stepPerDay, maxPerDay, days }) => {
      try {
        return okResult(buildWarmupPlan({ startPerDay, stepPerDay, maxPerDay, days }));
      } catch (error) {
        if (error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "warmup_status",
    {
      description: "Read warmup stats from a cold vendor.",
      inputSchema: {
        vendor: z.enum(["instantly", "smartlead"]).describe("Cold vendor."),
        emails: z.array(z.string()).optional().describe("Mailbox emails (instantly)."),
        accountId: z.string().optional().describe("Email account id (smartlead)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ vendor, emails, accountId }) => {
      try {
        if (vendor === "instantly") {
          if (!emails || emails.length === 0) {
            throw new VendorError("instantly: warmupAnalytics needs 1 to 100 emails");
          }
          return okResult(await instantly.warmupAnalytics(emails));
        }
        if (!accountId) {
          throw new VendorError("smartlead: accountId must not be empty");
        }
        return okResult(await smartlead.warmupStats(accountId));
      } catch (error) {
        if (error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "stop_campaign",
    {
      description: "Pause or stop a cold campaign.",
      inputSchema: {
        vendor: z.enum(["instantly", "smartlead"]).describe("Cold vendor."),
        campaignId: z.string().describe("Campaign id."),
        status: z
          .enum(["START", "PAUSED", "STOPPED", "ARCHIVED"])
          .optional()
          .describe("Smartlead status. Default: PAUSED. Instantly always pauses."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ vendor, campaignId, status }) => {
      try {
        if (vendor === "instantly") {
          return okResult(await instantly.pauseCampaign(campaignId));
        }
        return okResult(
          await smartlead.setCampaignStatus(campaignId, (status ?? "PAUSED") as SmartleadStatus),
        );
      } catch (error) {
        if (error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_cost_report",
    {
      description: "Read the cost report for this session.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => okResult(getCostReport()),
  );

  return server;
}

export async function startMcp(deps: McpDeps = {}): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
