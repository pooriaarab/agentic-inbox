import { VendorError, recordCost, type Guards, type Logger } from "./core.js";

// Message shapes. One message feeds every adapter. Cold adapters read
// the lead fields and queue the first recipient in a campaign.

export interface MailMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  unsubscribeUrl?: string;
  headers?: Record<string, string>;
  firstName?: string;
  lastName?: string;
  companyName?: string;
}

export interface MailReceipt {
  adapter: string;
  id: string;
  to: string[];
  at: string;
}

export interface MailAdapter {
  readonly name: string;
  send(message: MailMessage): Promise<MailReceipt>;
}

function isEmail(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 2 && value.includes("@");
}

export function validateMessage(message: MailMessage): void {
  if (!isEmail(message.from)) {
    throw new VendorError("mail: from needs an email address");
  }
  if (!Array.isArray(message.to) || message.to.length === 0 || !message.to.every(isEmail)) {
    throw new VendorError("mail: to needs at least one email address");
  }
  if (message.subject.trim().length === 0) {
    throw new VendorError("mail: subject must not be empty");
  }
  const html = (message.html ?? "").trim();
  const text = (message.text ?? "").trim();
  if (html.length === 0 && text.length === 0) {
    throw new VendorError("mail: html or text must not be empty");
  }
}

// One-click unsubscribe headers (RFC 8058). Bulk senders attach these
// so a mailbox can stop mail with one click.

export function oneClickHeaders(url: string): Record<string, string> {
  if (!/^https?:\/\/.+/.test(url)) {
    throw new VendorError("mail: unsubscribeUrl needs an http(s) URL");
  }
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

// Remote base. Adapters throw VendorError on missing keys, on network
// faults, and on non-2xx replies. They never swallow a failure.

export interface AdapterOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

type Row = Record<string, unknown>;

function object(value: unknown, what: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VendorError(`bad payload: expected object for ${what}`);
  }
  return value as Row;
}

function receiptId(value: unknown, adapter: string, fields: string[]): string {
  const row = object(value, `${adapter} receipt`);
  for (const field of fields) {
    const found = row[field];
    if (typeof found === "string" && found.length > 0) return found;
    if (typeof found === "number") return String(found);
  }
  throw new VendorError(`${adapter}: bad payload, missing receipt id`);
}

abstract class RemoteAdapter implements MailAdapter {
  abstract readonly name: string;

  constructor(protected options: AdapterOptions = {}) {}

  abstract send(message: MailMessage): Promise<MailReceipt>;

  protected key(env: string): string {
    const found = this.options.apiKey ?? process.env[env];
    if (!found?.trim()) {
      throw new VendorError(`${this.name}: missing ${env}`);
    }
    return found;
  }

  protected async request(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = this.options.timeoutMs ?? 10000,
  ): Promise<unknown> {
    let response: Response;
    try {
      const run = this.options.fetchFn ?? fetch;
      response = await run(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error instanceof VendorError) throw error;
      throw new VendorError(`${this.name}: request failed`, { cause: error });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = body.trim().slice(0, 200);
      throw new VendorError(
        `${this.name}: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        { status: response.status },
      );
    }
    const text = await response.text().catch(() => "");
    if (text.trim().length === 0) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text };
    }
  }
}

function withUnsubscribe(message: MailMessage): Record<string, string> {
  const headers: Record<string, string> = { ...(message.headers ?? {}) };
  if (message.unsubscribeUrl) {
    Object.assign(headers, oneClickHeaders(message.unsubscribeUrl));
  }
  return headers;
}

// Resend. POST https://api.resend.com/emails with a Bearer key.
// Docs: https://resend.com/docs/api-reference/emails/send-email

export class ResendAdapter extends RemoteAdapter {
  readonly name = "resend";

  async send(message: MailMessage): Promise<MailReceipt> {
    validateMessage(message);
    const headers = withUnsubscribe(message);
    const body: Record<string, unknown> = {
      from: message.from,
      to: message.to,
      subject: message.subject,
    };
    if (message.cc?.length) body.cc = message.cc;
    if (message.bcc?.length) body.bcc = message.bcc;
    if (message.html) body.html = message.html;
    if (message.text) body.text = message.text;
    if (message.replyTo) body.reply_to = message.replyTo;
    if (Object.keys(headers).length > 0) body.headers = headers;
    const payload = await this.request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.key("RESEND_API_KEY")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return {
      adapter: this.name,
      id: receiptId(payload, this.name, ["id"]),
      to: message.to,
      at: new Date().toISOString(),
    };
  }
}

// Postmark. POST https://api.postmarkapp.com/email with a server token.
// Docs: https://postmarkapp.com/developer/api/email-api

export interface PostmarkOptions extends AdapterOptions {
  messageStream?: string;
}

export class PostmarkAdapter extends RemoteAdapter {
  readonly name = "postmark";

  constructor(private config: PostmarkOptions = {}) {
    super(config);
  }

  async send(message: MailMessage): Promise<MailReceipt> {
    validateMessage(message);
    const headers = withUnsubscribe(message);
    const body: Record<string, unknown> = {
      From: message.from,
      To: message.to.join(","),
      Subject: message.subject,
      MessageStream: this.config.messageStream ?? "outbound",
    };
    if (message.cc?.length) body.Cc = message.cc.join(",");
    if (message.bcc?.length) body.Bcc = message.bcc.join(",");
    if (message.html) body.HtmlBody = message.html;
    if (message.text) body.TextBody = message.text;
    if (message.replyTo) body.ReplyTo = message.replyTo;
    const names = Object.keys(headers);
    if (names.length > 0) {
      body.Headers = names.map((name) => ({ Name: name, Value: headers[name] }));
    }
    const payload = await this.request("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.key("POSTMARK_SERVER_TOKEN"),
      },
      body: JSON.stringify(body),
    });
    return {
      adapter: this.name,
      id: receiptId(payload, this.name, ["MessageID", "id"]),
      to: message.to,
      at: new Date().toISOString(),
    };
  }
}

// Instantly. Cold mail runs through campaigns: the adapter adds the
// first recipient as a lead. POST https://api.instantly.ai/api/v2/leads
// with a Bearer key and { campaign, email, ... }.
// Docs: https://developer.instantly.ai/api-reference/lead/create-lead

export interface InstantlyOptions extends AdapterOptions {
  campaignId?: string;
}

export class InstantlyAdapter extends RemoteAdapter {
  readonly name = "instantly";

  constructor(private config: InstantlyOptions = {}) {
    super(config);
  }

  campaign(): string {
    const id = this.config.campaignId ?? process.env.INSTANTLY_CAMPAIGN_ID;
    if (!id?.trim()) {
      throw new VendorError("instantly: campaignId is required");
    }
    return id;
  }

  private auth(): Record<string, string> {
    return {
      authorization: `Bearer ${this.key("INSTANTLY_API_KEY")}`,
      "content-type": "application/json",
    };
  }

  async send(message: MailMessage): Promise<MailReceipt> {
    validateMessage(message);
    const email = message.to[0];
    const lead: Record<string, unknown> = { campaign: this.campaign(), email };
    if (message.firstName) lead.first_name = message.firstName;
    if (message.lastName) lead.last_name = message.lastName;
    if (message.companyName) lead.company_name = message.companyName;
    const payload = await this.request("https://api.instantly.ai/api/v2/leads", {
      method: "POST",
      headers: this.auth(),
      body: JSON.stringify(lead),
    });
    return {
      adapter: this.name,
      id: receiptId(payload, this.name, ["id", "lead_id"]),
      to: [email],
      at: new Date().toISOString(),
    };
  }

  async warmupAnalytics(emails: string[]): Promise<unknown> {
    if (emails.length === 0 || emails.length > 100) {
      throw new VendorError("instantly: warmupAnalytics needs 1 to 100 emails");
    }
    return this.request("https://api.instantly.ai/api/v2/accounts/warmup-analytics", {
      method: "POST",
      headers: this.auth(),
      body: JSON.stringify({ emails }),
    });
  }

  async pauseCampaign(campaignId: string): Promise<unknown> {
    if (!campaignId.trim()) {
      throw new VendorError("instantly: campaignId must not be empty");
    }
    return this.request(
      `https://api.instantly.ai/api/v2/campaigns/${encodeURIComponent(campaignId)}/pause`,
      { method: "POST", headers: this.auth() },
    );
  }
}

// Smartlead. Cold mail runs through campaigns: the adapter imports the
// first recipient as a lead. The key rides a query param.
// POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads?api_key=...
// Docs: https://api.smartlead.ai/guides/lead-management

export interface SmartleadOptions extends AdapterOptions {
  campaignId?: string;
}

export type SmartleadStatus = "START" | "PAUSED" | "STOPPED" | "ARCHIVED";

export class SmartleadAdapter extends RemoteAdapter {
  readonly name = "smartlead";

  constructor(private config: SmartleadOptions = {}) {
    super(config);
  }

  campaign(): string {
    const id = this.config.campaignId ?? process.env.SMARTLEAD_CAMPAIGN_ID;
    if (!id?.trim()) {
      throw new VendorError("smartlead: campaignId is required");
    }
    return id;
  }

  private withKey(path: string): string {
    return `https://server.smartlead.ai/api/v1${path}?api_key=${encodeURIComponent(
      this.key("SMARTLEAD_API_KEY"),
    )}`;
  }

  async send(message: MailMessage): Promise<MailReceipt> {
    validateMessage(message);
    const email = message.to[0];
    const campaignId = this.campaign();
    const lead: Record<string, unknown> = { email };
    if (message.firstName) lead.first_name = message.firstName;
    if (message.lastName) lead.last_name = message.lastName;
    if (message.companyName) lead.company_name = message.companyName;
    const payload = object(
      await this.request(this.withKey(`/campaigns/${encodeURIComponent(campaignId)}/leads`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lead_list: [lead],
          settings: {
            ignore_global_block_list: false,
            ignore_unsubscribe_list: false,
            ignore_duplicate_leads_in_other_campaign: false,
          },
        }),
      }),
      "smartlead lead import",
    );
    if (typeof payload.added_count !== "number") {
      throw new VendorError("smartlead: bad payload, missing added_count");
    }
    return {
      adapter: this.name,
      id: `${campaignId}:${email}`,
      to: [email],
      at: new Date().toISOString(),
    };
  }

  async warmupStats(accountId: string): Promise<unknown> {
    if (!accountId.trim()) {
      throw new VendorError("smartlead: accountId must not be empty");
    }
    return this.request(
      this.withKey(`/email-accounts/${encodeURIComponent(accountId)}/warmup-stats`),
    );
  }

  async setCampaignStatus(campaignId: string, status: SmartleadStatus): Promise<unknown> {
    if (!campaignId.trim()) {
      throw new VendorError("smartlead: campaignId must not be empty");
    }
    return this.request(this.withKey(`/campaigns/${encodeURIComponent(campaignId)}/status`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }
}

// DNS checks. SPF lives on the bare domain, DMARC under _dmarc, DKIM
// under {selector}._domainkey. Reads use real DNS unless a test passes
// resolveFn. The node:dns import stays lazy so edge hosts can load
// this module without it.

export interface DnsCheck {
  ok: boolean;
  records: string[];
}

export interface DnsReport {
  domain: string;
  spf: DnsCheck;
  dkim: DnsCheck;
  dmarc: DnsCheck;
  selector?: string;
}

export interface DnsOptions {
  selector?: string;
  resolveFn?: (host: string) => Promise<string[][]>;
}

function isDkimRecord(record: string): boolean {
  // RFC 6376: v defaults to DKIM1, so a record without v still
  // counts. An empty p means the key stands revoked.
  const tags = record
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  const version = tags.find((tag) => tag.startsWith("v="));
  if (version && version !== "v=dkim1") return false;
  const key = tags.find((tag) => tag.startsWith("p="));
  return !!key && key.length > 2;
}

export async function checkDns(domain: string, options: DnsOptions = {}): Promise<DnsReport> {
  const clean = domain.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(clean) || !clean.includes(".")) {
    throw new VendorError("mail: domain must look like example.com");
  }
  let resolve = options.resolveFn;
  if (!resolve) {
    const dns = await import("node:dns/promises");
    resolve = dns.resolveTxt;
  }
  const txt = async (host: string): Promise<string[]> => {
    try {
      const chunks = await resolve(host);
      return chunks.map((parts) => parts.join(""));
    } catch {
      return [];
    }
  };
  const spf = (await txt(clean)).filter((record) =>
    record.toLowerCase().startsWith("v=spf1"),
  );
  const dmarc = (await txt(`_dmarc.${clean}`)).filter((record) =>
    record.toLowerCase().startsWith("v=dmarc1"),
  );
  const selector = options.selector?.trim();
  const dkimSource = selector ? await txt(`${selector}._domainkey.${clean}`) : [];
  const dkim = dkimSource.filter(isDkimRecord);
  return {
    domain: clean,
    spf: { ok: spf.length > 0, records: spf },
    dkim: { ok: dkim.length > 0, records: dkim },
    dmarc: { ok: dmarc.length > 0, records: dmarc },
    ...(selector ? { selector } : {}),
  };
}

// Warmup plan. A pure ramp: start low, add a step each day, cap at
// max. Vendors run the warmup; this plan sets the pace.

export interface WarmupPlanDay {
  day: number;
  maxSends: number;
}

export interface WarmupPlanOptions {
  startPerDay?: number;
  stepPerDay?: number;
  maxPerDay?: number;
  days?: number;
}

export function buildWarmupPlan(options: WarmupPlanOptions = {}): WarmupPlanDay[] {
  const start = options.startPerDay ?? 10;
  const step = options.stepPerDay ?? 10;
  const max = options.maxPerDay ?? 100;
  const days = options.days ?? 14;
  const fields: [string, number][] = [
    ["startPerDay", start],
    ["stepPerDay", step],
    ["maxPerDay", max],
    ["days", days],
  ];
  for (const [label, value] of fields) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new VendorError(`mail: ${label} needs a positive integer`);
    }
  }
  return Array.from({ length: days }, (_, index) => ({
    day: index + 1,
    maxSends: Math.min(max, start + step * index),
  }));
}

// Fan-out send. Dry run is the default: it checks guards, calls no
// adapter, and records no cost. Live sends reserve guard capacity,
// then call each adapter and report each result on its own.

export interface SendOptions {
  adapters: MailAdapter[];
  guards?: Guards;
  logger?: Logger;
  dryRun?: boolean;
}

export interface AdapterSendResult {
  adapter: string;
  ok: boolean;
  receipt?: MailReceipt;
  error?: string;
}

export type SendResult =
  | { dryRun: true; to: string[]; adapters: string[] }
  | { dryRun: false; results: AdapterSendResult[] };

export async function sendMail(message: MailMessage, options: SendOptions): Promise<SendResult> {
  validateMessage(message);
  if (options.adapters.length === 0) {
    throw new VendorError("mail: select at least one adapter");
  }
  const guardText = `${message.subject}\n${message.text ?? ""}`;
  options.guards?.checkDispatch(guardText);
  if (options.dryRun ?? true) {
    return { dryRun: true, to: message.to, adapters: options.adapters.map((a) => a.name) };
  }
  for (const adapter of options.adapters) {
    options.guards?.checkDispatch(guardText);
    options.guards?.recordDispatch();
    options.logger?.debug(`send via ${adapter.name}`);
  }
  const results = await Promise.all(
    options.adapters.map(async (adapter): Promise<AdapterSendResult> => {
      let units = 0;
      try {
        const receipt = await adapter.send(message);
        units = receipt.to.length;
        return { adapter: adapter.name, ok: true, receipt };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        options.logger?.error(`${adapter.name}: ${text}`);
        return { adapter: adapter.name, ok: false, error: text };
      } finally {
        recordCost({ kind: "send", adapter: adapter.name, units });
      }
    }),
  );
  return { dryRun: false, results };
}

// Adapter sets. Keys come from adapter options or the environment.
// Campaign ids come from options or the environment.

export interface AdapterSetOptions {
  campaignId?: string;
  messageStream?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function defaultAdapters(options: AdapterSetOptions = {}): MailAdapter[] {
  const shared = { fetchFn: options.fetchFn, timeoutMs: options.timeoutMs };
  return [
    new ResendAdapter(shared),
    new PostmarkAdapter({ ...shared, messageStream: options.messageStream }),
    new InstantlyAdapter({ ...shared, campaignId: options.campaignId }),
    new SmartleadAdapter({ ...shared, campaignId: options.campaignId }),
  ];
}

export function selectAdapters(names: string[], options: AdapterSetOptions = {}): MailAdapter[] {
  const wanted = names.map((name) => name.trim().toLowerCase()).filter((n) => n.length > 0);
  if (wanted.length === 0 || wanted.includes("all")) {
    return defaultAdapters(options);
  }
  const all = defaultAdapters(options);
  return wanted.map((name) => {
    const found = all.find((adapter) => adapter.name === name);
    if (!found) {
      throw new VendorError(`mail: unknown adapter "${name}"`);
    }
    return found;
  });
}
