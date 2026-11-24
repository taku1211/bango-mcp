import { describe, expect, it } from "vitest";

import { BangoClient, BangoError } from "../src/client.js";

function sequence(statuses: number[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push(`${init.method} ${new URL(String(input)).pathname}`);
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 200;
    const body = status === 200 ? { object: "x", data: { ok: true } } : { code: "DEPENDENCY_UNAVAILABLE" };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("BangoClient retries", () => {
  it("re-reads a GET that hit a momentary 503", async () => {
    const { calls, fetchImpl } = sequence([503, 200]);
    const client = new BangoClient({ apiKey: "k", fetchImpl, retryDelaysMs: [0, 0] });

    await expect(client.get("/companies/profiles/count")).resolves.toMatchObject({ data: { ok: true } });
    expect(calls).toHaveLength(2);
  });

  it("gives up after the configured retries", async () => {
    const { calls, fetchImpl } = sequence([503]);
    const client = new BangoClient({ apiKey: "k", fetchImpl, retryDelaysMs: [0, 0] });

    await expect(client.get("/companies/profiles/count")).rejects.toBeInstanceOf(BangoError);
    expect(calls).toHaveLength(3);
  });

  it("does not retry other errors or POSTs", async () => {
    const notFound = sequence([404]);
    await expect(
      new BangoClient({ apiKey: "k", fetchImpl: notFound.fetchImpl, retryDelaysMs: [0] }).get("/v1/x"),
    ).rejects.toBeInstanceOf(BangoError);
    expect(notFound.calls).toHaveLength(1);

    const post = sequence([503]);
    await expect(
      new BangoClient({ apiKey: "k", fetchImpl: post.fetchImpl, retryDelaysMs: [0] }).post("/v1/x", {}),
    ).rejects.toBeInstanceOf(BangoError);
    expect(post.calls).toHaveLength(1);
  });
});

describe("BangoClient list search paused", () => {
  it("says list search is paused when its routes are gone", async () => {
    const { fetchImpl } = sequence([404]);
    const client = new BangoClient({ apiKey: "k", fetchImpl, retryDelaysMs: [] });

    await expect(client.get("/companies/profiles/count")).rejects.toThrow("一時停止中");
    await expect(client.get("/companies/profiles")).rejects.toThrow("一時停止中");
    await expect(client.post("/companies/profiles/exports", {})).rejects.toThrow("一時停止中");
    await expect(client.get("/companies/profiles/exports/abc")).rejects.toThrow("書き出しが見つかりません");
  });

  it("keeps the usual not-found message for other lookups", async () => {
    const { fetchImpl } = sequence([404]);
    const client = new BangoClient({ apiKey: "k", fetchImpl, retryDelaysMs: [] });

    await expect(client.get("/companies/1234567890123")).rejects.toThrow("該当するデータが見つかりませんでした");
  });
});
