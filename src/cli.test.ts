import { describe, expect, test } from "vitest";
import { parseArgs, runCli, UsageError, type CliIo } from "./cli.js";
import { VendorError } from "./core.js";
import { InstantlyAdapter, SmartleadAdapter, type MailMessage, type MailReceipt } from "./mail.js";

function testIo(overrides: Partial<CliIo> = {}): CliIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    readFile: (path) => `file:${path}`,
    adapters: [
      {
        name: "resend",
        send: async (message: MailMessage): Promise<MailReceipt> => ({
          adapter: "resend",
          id: "re_1",
          to: message.to,
          at: "now",
        }),
      },
      {
        name: "postmark",
        send: async (): Promise<MailReceipt> => {
          throw new VendorError("postmark: HTTP 401");
        },
      },
    ],
    instantly: new InstantlyAdapter({
      apiKey: "k",
      fetchFn: (async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
    }),
    smartlead: new SmartleadAdapter({
      apiKey: "k",
      fetchFn: (async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
    }),
    ...overrides,
  };
}

const SEND = ["send", "--from", "a@example.com", "--to", "b@example.com", "--subject", "Hi"];

describe("parseArgs", () => {
  test("empty args print help", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  test("--version selects version", () => {
    expect(parseArgs(["--version"]).command).toBe("version");
  });

  test("send takes from, to, subject, and text", () => {
    const request = parseArgs([...SEND, "--text", "hi", "--adapter", "resend", "--live"]);
    expect(request.command).toBe("send");
    expect(request.adapters).toEqual(["resend"]);
    expect(request.live).toBe(true);
  });

  test("send splits recipient lists", () => {
    const request = parseArgs([...SEND, "--text", "hi", "--to", "a@x.com, b@x.com"]);
    expect(request.to).toEqual(["a@x.com", "b@x.com"]);
  });

  test("send without a body throws", () => {
    expect(() => parseArgs(SEND)).toThrow(/--html, --text, or --file/);
  });

  test("send without parties throws", () => {
    expect(() => parseArgs(["send", "--text", "hi"])).toThrow(/--from, --to/);
  });

  test("dns needs a domain", () => {
    expect(() => parseArgs(["dns"])).toThrow(/--domain/);
    expect(parseArgs(["dns", "--domain", "example.com", "--selector", "s1"]).selector).toBe("s1");
  });

  test("warmup plan takes numbers", () => {
    const request = parseArgs(["warmup", "plan", "--days", "7"]);
    expect(request.sub).toBe("plan");
    expect(request.days).toBe(7);
  });

  test("warmup status pins the vendor", () => {
    expect(() => parseArgs(["warmup", "status"])).toThrow(/--vendor/);
    expect(() =>
      parseArgs(["warmup", "status", "--vendor", "instantly"]),
    ).toThrow(/--emails/);
    expect(() =>
      parseArgs(["warmup", "status", "--vendor", "smartlead"]),
    ).toThrow(/--account/);
  });

  test("stop needs vendor and campaign", () => {
    expect(() => parseArgs(["stop", "--campaign", "1"])).toThrow(/--vendor/);
    expect(() => parseArgs(["stop", "--vendor", "instantly"])).toThrow(/--campaign/);
    expect(() =>
      parseArgs(["stop", "--vendor", "smartlead", "--campaign", "1", "--status", "nope"]),
    ).toThrow(/--status/);
  });

  test("unknown command throws UsageError", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(UsageError);
  });
});

describe("runCli", () => {
  test("send dry run prints a preview", async () => {
    const io = testIo();
    const code = await runCli([...SEND, "--text", "hi"], io);
    expect(code).toBe(0);
    expect(JSON.parse(io.outLines[0])).toMatchObject({ dryRun: true, adapters: ["resend", "postmark"] });
  });

  test("send reads a file body when asked", async () => {
    const io = testIo();
    const code = await runCli([...SEND, "--file", "note.txt", "--adapter", "resend"], io);
    expect(code).toBe(0);
    expect(JSON.parse(io.outLines[0])).toMatchObject({ dryRun: true });
  });

  test("live send reports each adapter and exits 1 on failure", async () => {
    const io = testIo();
    const code = await runCli([...SEND, "--text", "hi", "--live"], io);
    expect(code).toBe(1);
    expect(JSON.parse(io.outLines[0])).toMatchObject({ dryRun: false });
  });

  test("live send exits 0 when each adapter succeeds", async () => {
    const io = testIo();
    const code = await runCli([...SEND, "--text", "hi", "--adapter", "resend", "--live"], io);
    expect(code).toBe(0);
    const result = JSON.parse(io.outLines[0]) as { results: { ok: boolean }[] };
    expect(result.results).toHaveLength(1);
    expect(result.results[0].ok).toBe(true);
  });

  test("unknown adapter exits 1", async () => {
    const io = testIo();
    const code = await runCli([...SEND, "--text", "hi", "--adapter", "pigeon"], io);
    expect(code).toBe(1);
    expect(io.errLines[0]).toContain("unknown adapter");
  });

  test("dns prints a report", async () => {
    const io = testIo({
      resolveFn: async (host: string) => {
        if (host === "example.com") return [["v=spf1 -all"]];
        throw new Error("none");
      },
    });
    const code = await runCli(["dns", "--domain", "example.com"], io);
    expect(code).toBe(0);
    expect(JSON.parse(io.outLines[0])).toMatchObject({ domain: "example.com" });
  });

  test("warmup plan prints days", async () => {
    const io = testIo();
    const code = await runCli(["warmup", "plan", "--days", "3"], io);
    expect(code).toBe(0);
    expect(JSON.parse(io.outLines[0])).toHaveLength(3);
  });

  test("warmup status and stop print vendor replies", async () => {
    const io = testIo();
    expect(
      await runCli(["warmup", "status", "--vendor", "instantly", "--emails", "a@x.com"], io),
    ).toBe(0);
    expect(
      await runCli(["warmup", "status", "--vendor", "smartlead", "--account", "5"], io),
    ).toBe(0);
    expect(await runCli(["stop", "--vendor", "instantly", "--campaign", "9"], io)).toBe(0);
    expect(
      await runCli(["stop", "--vendor", "smartlead", "--campaign", "9", "--status", "STOPPED"], io),
    ).toBe(0);
    expect(io.outLines).toHaveLength(4);
  });

  test("bad usage exits 2", async () => {
    const io = testIo();
    const code = await runCli(["bogus"], io);
    expect(code).toBe(2);
    expect(io.errLines.length).toBeGreaterThan(0);
  });

  test("version prints a version string", async () => {
    const io = testIo();
    const code = await runCli(["--version"], io);
    expect(code).toBe(0);
    expect(io.outLines[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
