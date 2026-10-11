import { afterEach, describe, expect, test, vi } from "vitest";
import { createGuards, getCostReport, GuardError, resetCosts, VendorError } from "./core.js";
import {
  buildWarmupPlan,
  checkDns,
  defaultAdapters,
  InstantlyAdapter,
  oneClickHeaders,
  PostmarkAdapter,
  ResendAdapter,
  selectAdapters,
  sendMail,
  SmartleadAdapter,
  validateMessage,
  type MailAdapter,
  type MailMessage,
} from "./mail.js";

const MESSAGE: MailMessage = {
  from: "sender@example.com",
  to: ["receiver@example.com"],
  subject: "Hello",
  text: "Hi there",
};

afterEach(() => {
  resetCosts();
  vi.unstubAllEnvs();
});

interface Call {
  url: string;
  init?: RequestInit;
}

function mockFetch(handler: (call: Call) => { status: number; payload: unknown }): {
  fetchFn: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const { status, payload } = handler(call);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function headerOf(call: Call, name: string): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.[name] ?? headers?.[name.toLowerCase()];
}

describe("validateMessage", () => {
  test("accepts a full message", () => {
    expect(() => validateMessage(MESSAGE)).not.toThrow();
  });

  test("rejects a bad sender", () => {
    expect(() => validateMessage({ ...MESSAGE, from: "not-an-email" })).toThrow(VendorError);
  });

  test("rejects an empty recipient list", () => {
    expect(() => validateMessage({ ...MESSAGE, to: [] })).toThrow(VendorError);
  });

  test("rejects an empty subject", () => {
    expect(() => validateMessage({ ...MESSAGE, subject: "  " })).toThrow(VendorError);
  });

  test("rejects a bodyless message", () => {
    expect(() => validateMessage({ ...MESSAGE, text: undefined })).toThrow(VendorError);
  });
});

describe("oneClickHeaders", () => {
  test("builds RFC 8058 headers", () => {
    expect(oneClickHeaders("https://example.com/stop")).toEqual({
      "List-Unsubscribe": "<https://example.com/stop>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  test("rejects a non-URL", () => {
    expect(() => oneClickHeaders("not-a-url")).toThrow(VendorError);
  });
});

describe("ResendAdapter", () => {
  test("posts the vendor shape and returns the receipt", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ status: 200, payload: { id: "re_1" } }));
    const adapter = new ResendAdapter({ apiKey: "re_test", fetchFn });
    const receipt = await adapter.send({
      ...MESSAGE,
      unsubscribeUrl: "https://example.com/stop",
    });
    expect(receipt).toMatchObject({ adapter: "resend", id: "re_1", to: MESSAGE.to });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init?.method).toBe("POST");
    expect(headerOf(calls[0], "authorization")).toBe("Bearer re_test");
    expect(bodyOf(calls[0])).toMatchObject({
      from: MESSAGE.from,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      headers: {
        "List-Unsubscribe": "<https://example.com/stop>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
  });

  test("reads the key from the environment", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_env");
    const { fetchFn, calls } = mockFetch(() => ({ status: 200, payload: { id: "re_2" } }));
    await new ResendAdapter({ fetchFn }).send(MESSAGE);
    expect(headerOf(calls[0], "authorization")).toBe("Bearer re_env");
  });

  test("throws when the key is missing", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 200, payload: { id: "re_3" } }));
    await expect(new ResendAdapter({ fetchFn }).send(MESSAGE)).rejects.toThrow(
      "missing RESEND_API_KEY",
    );
  });

  test("throws on a vendor error status", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 422, payload: { message: "bad from" } }));
    const error = await new ResendAdapter({ apiKey: "k", fetchFn })
      .send(MESSAGE)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).status).toBe(422);
  });

  test("throws on a network fault", async () => {
    const fetchFn = (async () => {
      throw new TypeError("down");
    }) as typeof fetch;
    await expect(new ResendAdapter({ apiKey: "k", fetchFn }).send(MESSAGE)).rejects.toThrow(
      "request failed",
    );
  });

  test("throws on a receipt without an id", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 200, payload: {} }));
    await expect(new ResendAdapter({ apiKey: "k", fetchFn }).send(MESSAGE)).rejects.toThrow(
      "missing receipt id",
    );
  });
});

describe("PostmarkAdapter", () => {
  test("posts the vendor shape with headers array", async () => {
    const { fetchFn, calls } = mockFetch(() => ({
      status: 200,
      payload: { MessageID: 42, To: "receiver@example.com", SubmittedAt: "now", ErrorCode: 0 },
    }));
    const adapter = new PostmarkAdapter({ apiKey: "pm_test", fetchFn });
    const receipt = await adapter.send({
      ...MESSAGE,
      unsubscribeUrl: "https://example.com/stop",
    });
    expect(receipt).toMatchObject({ adapter: "postmark", id: "42" });
    expect(calls[0].url).toBe("https://api.postmarkapp.com/email");
    expect(headerOf(calls[0], "X-Postmark-Server-Token")).toBe("pm_test");
    expect(bodyOf(calls[0])).toMatchObject({
      From: MESSAGE.from,
      To: "receiver@example.com",
      Subject: MESSAGE.subject,
      TextBody: MESSAGE.text,
      MessageStream: "outbound",
      Headers: [
        { Name: "List-Unsubscribe", Value: "<https://example.com/stop>" },
        { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
      ],
    });
  });

  test("honors a custom message stream", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ status: 200, payload: { MessageID: 1 } }));
    await new PostmarkAdapter({ apiKey: "k", fetchFn, messageStream: "broadcast" }).send(MESSAGE);
    expect(bodyOf(calls[0]).MessageStream).toBe("broadcast");
  });

  test("throws when the token is missing", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 200, payload: { MessageID: 1 } }));
    await expect(new PostmarkAdapter({ fetchFn }).send(MESSAGE)).rejects.toThrow(
      "missing POSTMARK_SERVER_TOKEN",
    );
  });

  test("throws on a vendor error status", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 401, payload: { ErrorCode: 10 } }));
    const error = await new PostmarkAdapter({ apiKey: "k", fetchFn })
      .send(MESSAGE)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).status).toBe(401);
  });
});

describe("InstantlyAdapter", () => {
  test("adds the first recipient as a lead", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ status: 200, payload: { id: "lead_1" } }));
    const adapter = new InstantlyAdapter({ apiKey: "in_test", fetchFn, campaignId: "camp_1" });
    const receipt = await adapter.send({
      ...MESSAGE,
      firstName: "Ada",
      lastName: "L",
      companyName: "Acme",
    });
    expect(receipt).toMatchObject({ adapter: "instantly", id: "lead_1" });
    expect(calls[0].url).toBe("https://api.instantly.ai/api/v2/leads");
    expect(headerOf(calls[0], "authorization")).toBe("Bearer in_test");
    expect(bodyOf(calls[0])).toEqual({
      campaign: "camp_1",
      email: "receiver@example.com",
      first_name: "Ada",
      last_name: "L",
      company_name: "Acme",
    });
  });

  test("requires a campaign", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 200, payload: { id: "lead_2" } }));
    await expect(new InstantlyAdapter({ apiKey: "k", fetchFn }).send(MESSAGE)).rejects.toThrow(
      "campaignId is required",
    );
  });

  test("throws on a vendor error status", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 401, payload: { error: "bad key" } }));
    const error = await new InstantlyAdapter({ apiKey: "k", fetchFn, campaignId: "c" })
      .send(MESSAGE)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).status).toBe(401);
  });

  test("reads warmup analytics for given mailboxes", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ status: 200, payload: { ok: true } }));
    const result = await new InstantlyAdapter({ apiKey: "k", fetchFn }).warmupAnalytics([
      "a@example.com",
    ]);
    expect(result).toEqual({ ok: true });
    expect(calls[0].url).toBe("https://api.instantly.ai/api/v2/accounts/warmup-analytics");
    expect(bodyOf(calls[0])).toEqual({ emails: ["a@example.com"] });
  });

  test("warmup analytics needs 1 to 100 emails", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 200, payload: {} }));
    await expect(
      new InstantlyAdapter({ apiKey: "k", fetchFn }).warmupAnalytics([]),
    ).rejects.toThrow("1 to 100");
  });

  test("pauses a campaign", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ status: 200, payload: { paused: true } }));
    await new InstantlyAdapter({ apiKey: "k", fetchFn }).pauseCampaign("camp_9");
    expect(calls[0].url).toBe("https://api.instantly.ai/api/v2/campaigns/camp_9/pause");
    expect(calls[0].init?.method).toBe("POST");
  });
});

describe("SmartleadAdapter", () => {
  test("imports the first recipient as a lead", async () => {
    const { fetchFn, calls } = mockFetch(() => ({
      status: 200,
      payload: { added_count: 1, skipped_count: 0 },
    }));
    const adapter = new SmartleadAdapter({ apiKey: "sl_test", fetchFn, campaignId: "77" });
    const receipt = await adapter.send({ ...MESSAGE, firstName: "Ada" });
    expect(receipt).toMatchObject({ adapter: "smartlead", id: "77:receiver@example.com" });
    expect(calls[0].url).toBe(
      "https://server.smartlead.ai/api/v1/campaigns/77/leads?api_key=sl_test",
    );
    expect(bodyOf(calls[0])).toEqual({
      lead_list: [{ email: "receiver@example.com", first_name: "Ada" }],
      settings: {
        ignore_global_block_list: false,
        ignore_unsubscribe_list: false,
        ignore_duplicate_leads_in_other_campaign: false,
      },
    });
  });

  test("requires a campaign", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 200, payload: { added_count: 1 } }));
    await expect(new SmartleadAdapter({ apiKey: "k", fetchFn }).send(MESSAGE)).rejects.toThrow(
      "campaignId is required",
    );
  });

  test("throws when added_count is missing", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 200, payload: { ok: true } }));
    await expect(
      new SmartleadAdapter({ apiKey: "k", fetchFn, campaignId: "1" }).send(MESSAGE),
    ).rejects.toThrow("missing added_count");
  });

  test("throws on a vendor error status", async () => {
    const { fetchFn } = mockFetch(() => ({ status: 401, payload: { message: "bad key" } }));
    const error = await new SmartleadAdapter({ apiKey: "k", fetchFn, campaignId: "1" })
      .send(MESSAGE)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).status).toBe(401);
  });

  test("reads warmup stats for an account", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ status: 200, payload: { score: 99 } }));
    const result = await new SmartleadAdapter({ apiKey: "k", fetchFn }).warmupStats("55");
    expect(result).toEqual({ score: 99 });
    expect(calls[0].url).toBe(
      "https://server.smartlead.ai/api/v1/email-accounts/55/warmup-stats?api_key=k",
    );
  });

  test("sets campaign status", async () => {
    const { fetchFn, calls } = mockFetch(() => ({ status: 200, payload: { success: true } }));
    await new SmartleadAdapter({ apiKey: "k", fetchFn }).setCampaignStatus("55", "STOPPED");
    expect(calls[0].url).toBe(
      "https://server.smartlead.ai/api/v1/campaigns/55/status?api_key=k",
    );
    expect(calls[0].init?.method).toBe("POST");
    expect(bodyOf(calls[0])).toEqual({ status: "STOPPED" });
  });
});

describe("checkDns", () => {
  const resolveFn = async (host: string): Promise<string[][]> => {
    if (host === "example.com") return [["v=spf1 include:mail.example.com ~all"]];
    if (host === "_dmarc.example.com") return [["v=DMARC1; p=reject"]];
    if (host === "s1._domainkey.example.com") return [["v=DKIM1; k=rsa; p=abc"]];
    throw new Error("no records");
  };

  test("reports spf, dkim, and dmarc", async () => {
    const report = await checkDns("example.com", { selector: "s1", resolveFn });
    expect(report.domain).toBe("example.com");
    expect(report.spf.ok).toBe(true);
    expect(report.dkim.ok).toBe(true);
    expect(report.dmarc.ok).toBe(true);
    expect(report.selector).toBe("s1");
  });

  test("a DKIM record without v counts, a revoked key does not", async () => {
    const live = await checkDns("example.com", {
      selector: "s1",
      resolveFn: async (host: string) => {
        if (host === "s1._domainkey.example.com") return [["k=rsa; t=s; p=abc123"]];
        throw new Error("none");
      },
    });
    expect(live.dkim.ok).toBe(true);
    const revoked = await checkDns("example.com", {
      selector: "s1",
      resolveFn: async (host: string) => {
        if (host === "s1._domainkey.example.com") return [["v=DKIM1; p="]];
        throw new Error("none");
      },
    });
    expect(revoked.dkim.ok).toBe(false);
  });

  test("missing records read as not ok", async () => {
    const report = await checkDns("example.com", {
      resolveFn: async () => {
        throw new Error("NXDOMAIN");
      },
    });
    expect(report.spf.ok).toBe(false);
    expect(report.dkim.ok).toBe(false);
    expect(report.dmarc.ok).toBe(false);
  });

  test("rejects a bad domain", async () => {
    await expect(checkDns("not a domain", { resolveFn })).rejects.toThrow("example.com");
  });
});

describe("buildWarmupPlan", () => {
  test("ramps from start to max", () => {
    const plan = buildWarmupPlan({ startPerDay: 10, stepPerDay: 10, maxPerDay: 25, days: 4 });
    expect(plan).toEqual([
      { day: 1, maxSends: 10 },
      { day: 2, maxSends: 20 },
      { day: 3, maxSends: 25 },
      { day: 4, maxSends: 25 },
    ]);
  });

  test("defaults to a 14 day plan", () => {
    const plan = buildWarmupPlan();
    expect(plan).toHaveLength(14);
    expect(plan[0]).toEqual({ day: 1, maxSends: 10 });
  });

  test("rejects bad numbers", () => {
    expect(() => buildWarmupPlan({ days: 0 })).toThrow("days");
  });
});

describe("sendMail", () => {
  function stub(name: string, fail?: string): MailAdapter & { calls: number } {
    const adapter = {
      name,
      calls: 0,
      send: async (message: MailMessage) => {
        adapter.calls += 1;
        if (fail) throw new VendorError(fail);
        return { adapter: name, id: `${name}-1`, to: message.to, at: "now" };
      },
    };
    return adapter;
  }

  test("dry run is the default and calls no adapter", async () => {
    const adapter = stub("resend");
    const result = await sendMail(MESSAGE, { adapters: [adapter] });
    expect(result).toEqual({ dryRun: true, to: MESSAGE.to, adapters: ["resend"] });
    expect(adapter.calls).toBe(0);
    expect(getCostReport().dispatches).toBe(0);
  });

  test("live send fans out and reports each adapter", async () => {
    const ok = stub("resend");
    const bad = stub("postmark", "postmark: HTTP 401");
    const result = await sendMail(MESSAGE, { adapters: [ok, bad], dryRun: false });
    expect(result).toEqual({
      dryRun: false,
      results: [
        { adapter: "resend", ok: true, receipt: { adapter: "resend", id: "resend-1", to: MESSAGE.to, at: "now" } },
        { adapter: "postmark", ok: false, error: "postmark: HTTP 401" },
      ],
    });
    const report = getCostReport();
    expect(report.entries).toHaveLength(2);
    expect(report.units).toBe(1);
  });

  test("a denied guard throws before any adapter runs", async () => {
    const adapter = stub("resend");
    const guards = createGuards({ blocklist: ["spam"] });
    await expect(
      sendMail({ ...MESSAGE, subject: "spam offer" }, { adapters: [adapter], guards, dryRun: false }),
    ).rejects.toThrow(GuardError);
    expect(adapter.calls).toBe(0);
    expect(getCostReport().dispatches).toBe(0);
  });

  test("empty adapter list throws", async () => {
    await expect(sendMail(MESSAGE, { adapters: [], dryRun: true })).rejects.toThrow(
      "at least one adapter",
    );
  });
});

describe("adapter sets", () => {
  test("defaultAdapters names four vendors", () => {
    expect(defaultAdapters().map((adapter) => adapter.name)).toEqual([
      "resend",
      "postmark",
      "instantly",
      "smartlead",
    ]);
  });

  test("selectAdapters picks by name and takes all", () => {
    expect(selectAdapters(["resend"]).map((a) => a.name)).toEqual(["resend"]);
    expect(selectAdapters(["all"])).toHaveLength(4);
    expect(selectAdapters([])).toHaveLength(4);
  });

  test("selectAdapters rejects unknown names", () => {
    expect(() => selectAdapters(["pigeon"])).toThrow('unknown adapter "pigeon"');
  });
});
