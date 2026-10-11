import { describe, expect, test } from "vitest";
import worker from "./worker.js";

describe("worker", () => {
  test("GET /health reports ok", async () => {
    const response = await worker.fetch(new Request("https://pack.test/health"), {
      PACK_NAME: "probe",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pack: "probe" });
  });

  test("POST /preview shapes a dry run", async () => {
    const response = await worker.fetch(
      new Request("https://pack.test/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: "a@example.com",
          to: ["b@example.com"],
          subject: "Hi",
          text: "hi",
        }),
      }),
      {},
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dryRun: true, to: ["b@example.com"] });
  });

  test("POST /preview rejects a bad message", async () => {
    const response = await worker.fetch(
      new Request("https://pack.test/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "Hi" }),
      }),
      {},
    );
    expect(response.status).toBe(400);
  });

  test("POST /warmup-plan returns days", async () => {
    const response = await worker.fetch(
      new Request("https://pack.test/warmup-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days: 3 }),
      }),
      {},
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(3);
  });

  test("POST /warmup-plan rejects bad numbers", async () => {
    const response = await worker.fetch(
      new Request("https://pack.test/warmup-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days: 0 }),
      }),
      {},
    );
    expect(response.status).toBe(400);
  });

  test("unknown routes return 404", async () => {
    const response = await worker.fetch(new Request("https://pack.test/nowhere"), {});
    expect(response.status).toBe(404);
  });
});
