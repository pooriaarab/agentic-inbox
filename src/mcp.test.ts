import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createMcpServer } from "./mcp.js";

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content[0].text;
}

async function linked(deps: Parameters<typeof createMcpServer>[0] = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(deps);
  await server.connect(serverTransport);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

describe("mcp server", () => {
  test("serves six tools over a client link", async () => {
    const { client, server } = await linked();
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "check_dns",
        "get_cost_report",
        "send_mail",
        "stop_campaign",
        "warmup_plan",
        "warmup_status",
      ]);

      const preview = await client.callTool({
        name: "send_mail",
        arguments: {
          from: "a@example.com",
          to: ["b@example.com"],
          subject: "Hi",
          text: "hi",
          dryRun: true,
        },
      });
      expect(JSON.parse(textOf(preview))).toMatchObject({ dryRun: true });

      const plan = await client.callTool({
        name: "warmup_plan",
        arguments: { days: 3 },
      });
      expect(JSON.parse(textOf(plan))).toHaveLength(3);

      const report = await client.callTool({ name: "get_cost_report", arguments: {} });
      expect(JSON.parse(textOf(report))).toHaveProperty("dispatches");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("check_dns reads injected records", async () => {
    const { client, server } = await linked({
      resolveFn: async (host: string) => {
        if (host === "_dmarc.example.com") return [["v=DMARC1; p=reject"]];
        throw new Error("none");
      },
    });
    try {
      const result = await client.callTool({
        name: "check_dns",
        arguments: { domain: "example.com" },
      });
      const report = JSON.parse(textOf(result)) as { dmarc: { ok: boolean }; spf: { ok: boolean } };
      expect(report.dmarc.ok).toBe(true);
      expect(report.spf.ok).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("a blocked send returns a tool error, not a crash", async () => {
    const { createGuards } = await import("./core.js");
    const { client, server } = await linked({ guards: createGuards({ blocklist: ["nope"] }) });
    try {
      const result = await client.callTool({
        name: "send_mail",
        arguments: {
          from: "a@example.com",
          to: ["b@example.com"],
          subject: "nope",
          text: "hi",
          dryRun: true,
        },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("blocklisted");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
