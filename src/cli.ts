#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getCostReport, GuardError, VendorError } from "./core.js";
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
import { VERSION } from "./version.js";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type CliCommand = "send" | "dns" | "warmup" | "stop" | "costs" | "mcp" | "help" | "version";

export interface CliRequest {
  command: CliCommand;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  html?: string;
  text?: string;
  file?: string;
  replyTo?: string;
  unsubscribeUrl?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  adapters?: string[];
  campaignId?: string;
  live: boolean;
  domain?: string;
  selector?: string;
  sub?: string;
  vendor?: string;
  accountId?: string;
  emails?: string[];
  status?: string;
  startPerDay?: number;
  stepPerDay?: number;
  maxPerDay?: number;
  days?: number;
}

const VALUE_FLAGS = new Set([
  "--from",
  "--to",
  "--cc",
  "--bcc",
  "--subject",
  "--html",
  "--text",
  "--file",
  "--reply-to",
  "--unsubscribe-url",
  "--first-name",
  "--last-name",
  "--company",
  "--adapter",
  "--campaign",
  "--domain",
  "--selector",
  "--vendor",
  "--account",
  "--emails",
  "--status",
  "--start",
  "--step",
  "--max",
  "--days",
]);

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function readInt(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} needs a positive integer, got "${value}"`);
  }
  return parsed;
}

export function parseArgs(argv: string[]): CliRequest {
  const request: CliRequest = { command: "help", live: false };
  const args = [...argv];
  const first = args.shift();
  if (first === undefined || first === "--help" || first === "-h") {
    return request;
  }
  if (first === "--version" || first === "-V") {
    request.command = "version";
    return request;
  }
  if (
    first !== "send" &&
    first !== "dns" &&
    first !== "warmup" &&
    first !== "stop" &&
    first !== "costs" &&
    first !== "mcp"
  ) {
    throw new UsageError(`unknown command "${first}"`);
  }
  request.command = first;
  if (first === "warmup" && args.length > 0 && !args[0].startsWith("--")) {
    request.sub = args.shift();
  }
  while (args.length > 0) {
    const flag = args.shift() as string;
    if (flag === "--live" && request.command === "send") {
      request.live = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag) || args.length === 0) {
      throw new UsageError(`unknown flag "${flag}" for "${request.command}"`);
    }
    const value = args.shift() as string;
    switch (flag) {
      case "--from":
        request.from = value;
        break;
      case "--to":
        request.to = splitList(value);
        break;
      case "--cc":
        request.cc = splitList(value);
        break;
      case "--bcc":
        request.bcc = splitList(value);
        break;
      case "--subject":
        request.subject = value;
        break;
      case "--html":
        request.html = value;
        break;
      case "--text":
        request.text = value;
        break;
      case "--file":
        request.file = value;
        break;
      case "--reply-to":
        request.replyTo = value;
        break;
      case "--unsubscribe-url":
        request.unsubscribeUrl = value;
        break;
      case "--first-name":
        request.firstName = value;
        break;
      case "--last-name":
        request.lastName = value;
        break;
      case "--company":
        request.companyName = value;
        break;
      case "--adapter":
        request.adapters = splitList(value);
        break;
      case "--campaign":
        request.campaignId = value;
        break;
      case "--domain":
        request.domain = value;
        break;
      case "--selector":
        request.selector = value;
        break;
      case "--vendor":
        request.vendor = value.toLowerCase();
        break;
      case "--account":
        request.accountId = value;
        break;
      case "--emails":
        request.emails = splitList(value);
        break;
      case "--status":
        request.status = value.toUpperCase();
        break;
      case "--start":
        request.startPerDay = readInt(flag, value);
        break;
      case "--step":
        request.stepPerDay = readInt(flag, value);
        break;
      case "--max":
        request.maxPerDay = readInt(flag, value);
        break;
      case "--days":
        request.days = readInt(flag, value);
        break;
    }
  }
  if (request.command === "send") {
    if (!request.from || !request.to || !request.subject) {
      throw new UsageError("send needs --from, --to, and --subject");
    }
    if (request.html === undefined && request.text === undefined && request.file === undefined) {
      throw new UsageError("send needs --html, --text, or --file");
    }
  }
  if (request.command === "dns" && !request.domain) {
    throw new UsageError("dns needs --domain");
  }
  if (request.command === "warmup") {
    if (request.sub !== "plan" && request.sub !== "status") {
      throw new UsageError('warmup needs "plan" or "status"');
    }
    if (request.sub === "status" && request.vendor !== "instantly" && request.vendor !== "smartlead") {
      throw new UsageError("warmup status needs --vendor instantly or smartlead");
    }
    if (request.sub === "status" && request.vendor === "instantly" && !request.emails) {
      throw new UsageError("warmup status for instantly needs --emails");
    }
    if (request.sub === "status" && request.vendor === "smartlead" && !request.accountId) {
      throw new UsageError("warmup status for smartlead needs --account");
    }
  }
  if (request.command === "stop") {
    if (request.vendor !== "instantly" && request.vendor !== "smartlead") {
      throw new UsageError("stop needs --vendor instantly or smartlead");
    }
    if (!request.campaignId) {
      throw new UsageError("stop needs --campaign");
    }
    if (
      request.status !== undefined &&
      request.status !== "START" &&
      request.status !== "PAUSED" &&
      request.status !== "STOPPED" &&
      request.status !== "ARCHIVED"
    ) {
      throw new UsageError("stop --status takes START, PAUSED, STOPPED, or ARCHIVED");
    }
  }
  return request;
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): string;
  adapters: MailAdapter[];
  instantly: InstantlyAdapter;
  smartlead: SmartleadAdapter;
  resolveFn?: DnsOptions["resolveFn"];
}

function defaultIo(): CliIo {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readFile: (path) => readFileSync(path, "utf8"),
    adapters: defaultAdapters(),
    instantly: new InstantlyAdapter(),
    smartlead: new SmartleadAdapter(),
  };
}

function helpText(): string {
  const command = DEFAULT_BRAND.command;
  return [
    `${DEFAULT_BRAND.name} ${VERSION}`,
    `${DEFAULT_BRAND.description}`,
    "",
    `Usage: ${command} <command> [flags]`,
    "",
    "Commands:",
    "  send --from <e> --to <e> --subject <s> [--html <h>] [--text <t>] [--file <p>]",
    "       [--cc <e>] [--bcc <e>] [--adapter <names>] [--campaign <id>] [--live]",
    "       [--reply-to <e>] [--unsubscribe-url <u>]  Send one mail. Dry run is",
    "       the default. Add --live to send for real.",
    "  dns --domain <d> [--selector <s>]  Check SPF, DKIM, and DMARC records.",
    "  warmup plan [--start <n>] [--step <n>] [--max <n>] [--days <n>]",
    "       Print a daily send ramp.",
    "  warmup status --vendor instantly --emails <a,b>  Read warmup analytics.",
    "  warmup status --vendor smartlead --account <id>  Read warmup stats.",
    "  stop --vendor <v> --campaign <id> [--status <s>]  Pause or stop a",
    "       campaign. Smartlead status takes START, PAUSED, STOPPED, ARCHIVED.",
    "  costs  Print the cost report as JSON.",
    "  mcp  Start the MCP server on stdio.",
    "",
    "Flags:",
    "  --help, -h       Print this help.",
    "  --version, -V    Print the version.",
  ].join("\n");
}

function pickAdapters(request: CliRequest, io: CliIo): MailAdapter[] {
  if (!request.adapters || request.adapters.includes("all")) {
    return io.adapters;
  }
  return request.adapters.map((name) => {
    const found = io.adapters.find((adapter) => adapter.name === name.toLowerCase());
    if (!found) {
      throw new UsageError(`unknown adapter "${name}"`);
    }
    return found;
  });
}

function rebindCampaigns(adapters: MailAdapter[], campaignId?: string): MailAdapter[] {
  if (!campaignId) return adapters;
  return adapters.map((adapter) => {
    if (adapter instanceof InstantlyAdapter) {
      return new InstantlyAdapter({ campaignId });
    }
    if (adapter instanceof SmartleadAdapter) {
      return new SmartleadAdapter({ campaignId });
    }
    return adapter;
  });
}

function buildMessage(request: CliRequest, io: CliIo): MailMessage {
  const message: MailMessage = {
    from: request.from as string,
    to: request.to as string[],
    subject: request.subject as string,
  };
  if (request.cc) message.cc = request.cc;
  if (request.bcc) message.bcc = request.bcc;
  if (request.html !== undefined) message.html = request.html;
  message.text = request.file !== undefined ? io.readFile(request.file) : request.text;
  if (request.replyTo) message.replyTo = request.replyTo;
  if (request.unsubscribeUrl) message.unsubscribeUrl = request.unsubscribeUrl;
  if (request.firstName) message.firstName = request.firstName;
  if (request.lastName) message.lastName = request.lastName;
  if (request.companyName) message.companyName = request.companyName;
  return message;
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  let request: CliRequest;
  try {
    request = parseArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(`Run "${DEFAULT_BRAND.command} --help" for usage.`);
    return 2;
  }
  try {
    switch (request.command) {
      case "help":
        io.out(helpText());
        return 0;
      case "version":
        io.out(VERSION);
        return 0;
      case "send": {
        const result = await sendMail(buildMessage(request, io), {
          adapters: rebindCampaigns(pickAdapters(request, io), request.campaignId),
          dryRun: !request.live,
        });
        io.out(JSON.stringify(result));
        if (!result.dryRun && result.results.some((entry) => !entry.ok)) {
          return 1;
        }
        return 0;
      }
      case "dns": {
        const report = await checkDns(request.domain as string, {
          selector: request.selector,
          resolveFn: io.resolveFn,
        });
        io.out(JSON.stringify(report));
        return 0;
      }
      case "warmup": {
        if (request.sub === "plan") {
          io.out(
            JSON.stringify(
              buildWarmupPlan({
                startPerDay: request.startPerDay,
                stepPerDay: request.stepPerDay,
                maxPerDay: request.maxPerDay,
                days: request.days,
              }),
            ),
          );
          return 0;
        }
        const stats =
          request.vendor === "instantly"
            ? await io.instantly.warmupAnalytics(request.emails as string[])
            : await io.smartlead.warmupStats(request.accountId as string);
        io.out(JSON.stringify(stats));
        return 0;
      }
      case "stop": {
        const stopped =
          request.vendor === "instantly"
            ? await io.instantly.pauseCampaign(request.campaignId as string)
            : await io.smartlead.setCampaignStatus(
                request.campaignId as string,
                (request.status ?? "PAUSED") as SmartleadStatus,
              );
        io.out(JSON.stringify(stopped));
        return 0;
      }
      case "costs":
        io.out(JSON.stringify(getCostReport()));
        return 0;
      case "mcp": {
        const { startMcp } = await import("./mcp.js");
        await startMcp();
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof GuardError || error instanceof VendorError || error instanceof UsageError) {
      io.err(`${error.name}: ${error.message}`);
      return 1;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      io.err(`file not found: ${request.file ?? ""}`);
      return 1;
    }
    throw error;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      // Exit nonzero at once. On zero, fall off the end so a running
      // server (mcp) keeps its stdio handles open. Plain commands
      // hold no handles and exit 0 on their own.
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
