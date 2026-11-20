import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { BangoClient } from "../src/client.js";
import { parseDate, parseIdentifier, parseRegistrationNumber } from "../src/normalize.js";
import { toPrefectureCode } from "../src/prefectures.js";
import { createServer } from "../src/server.js";

type Route = (url: URL, init: RequestInit) => { status: number; body: unknown };

function fakeFetch(route: Route, calls: Array<{ url: URL; init: RequestInit }> = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const { status, body } = route(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function connect(route: Route, opts: { apiKey?: string | null; calls?: Array<{ url: URL; init: RequestInit }> } = {}) {
  const apiKey = opts.apiKey === null ? undefined : (opts.apiKey ?? "test-key");
  const bango = new BangoClient({ apiKey, fetchImpl: fakeFetch(route, opts.calls) });
  const server = createServer({ client: bango, batchPollMs: 1, batchWaitMs: 50 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const env = (object: string, data: unknown, extra: Record<string, unknown> = {}) => ({ object, data, ...extra });

const invoiceToyota = {
  registration_number: "T1180301018771",
  found: true,
  registered: true,
  valid: true,
  registration_date: "2023-10-01",
  cancel_date: null,
  expire_date: null,
  country: "domestic",
};

describe("normalize", () => {
  it("parses identifiers with hyphens and full-width digits", () => {
    expect(parseIdentifier("T1-1803-0101-8771")).toEqual({ kind: "registration_number", value: "T1180301018771" });
    expect(parseIdentifier("１１８０３０１０１８７７１")).toEqual({ kind: "corporate_number", value: "1180301018771" });
    expect(parseIdentifier("t1180301018771")).toEqual({ kind: "registration_number", value: "T1180301018771" });
    expect(parseIdentifier("12345")).toBeNull();
    expect(parseRegistrationNumber("1180301018771")).toBe("T1180301018771");
  });
  it("parses dates", () => {
    expect(parseDate("2024/10/1")).toBe("2024-10-01");
    expect(parseDate("2024年10月1日")).toBe("2024-10-01");
    expect(parseDate("2024-02-30")).toBeNull();
  });
  it("parses prefectures", () => {
    expect(toPrefectureCode("大阪")).toBe("27");
    expect(toPrefectureCode("東京都")).toBe("13");
    expect(toPrefectureCode("北海道")).toBe("01");
    expect(toPrefectureCode("osaka")).toBe("27");
    expect(toPrefectureCode("13")).toBe("13");
    expect(toPrefectureCode("9")).toBe("09");
    expect(toPrefectureCode("火星")).toBeNull();
  });
});

describe("tools", () => {
  it("lists four read-only tools with annotations", async () => {
    const client = await connect(() => ({ status: 500, body: {} }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bango_check_invoice",
      "bango_find_company",
      "bango_get_company",
      "bango_match_companies",
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description?.length ?? 0).toBeGreaterThan(100);
    }
  });

  it("bango_find_company maps prefecture and returns candidates with a hint", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const client = await connect(
      () => ({
        status: 200,
        body: env(
          "list",
          [
            { corporate_number: "1180301018771", name: "トヨタ自動車株式会社", name_kana: "トヨタジドウシャ", prefecture_code: "23", city_code: "23211", score: 0.9 },
            { corporate_number: "1430005009042", name: "トヨタ自動車北海道労働組合", name_kana: null, prefecture_code: "01", city_code: "01213", score: 0.8 },
          ],
          { has_more: true },
        ),
      }),
      { calls },
    );
    const res = await client.callTool({ name: "bango_find_company", arguments: { company_name: "トヨタ自動車", prefecture: "愛知" } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.candidates[0]).toMatchObject({ corporate_number: "1180301018771", prefecture: "愛知県" });
    expect(sc.hint).toContain("複数");
    expect(calls[0].url.pathname).toBe("/v1/companies/search");
    expect(calls[0].url.searchParams.get("prefecture_code")).toBe("23");
    expect(calls[0].url.searchParams.get("limit")).toBe("5");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["user-agent"]).toMatch(/^bango-mcp\//);
  });

  it("bango_find_company rejects an unknown prefecture without calling the API", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const client = await connect(() => ({ status: 200, body: env("list", []) }), { calls });
    const res = await client.callTool({ name: "bango_find_company", arguments: { company_name: "x", prefecture: "火星" } });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("bango_get_company routes corporate numbers and T-numbers", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const client = await connect(
      (url) => {
        if (url.pathname.startsWith("/v1/companies/")) {
          return {
            status: 200,
            body: env("company", {
              corporate_number: "1180301018771",
              name: "トヨタ自動車株式会社",
              name_kana: "トヨタジドウシャ",
              name_en: null,
              kind: "株式会社",
              active: true,
              closure: null,
              address: { full: "愛知県豊田市トヨタ町１番地", post_code: "4710826", prefecture: "愛知県", prefecture_code: "23", city: "豊田市" },
              invoice: invoiceToyota,
              updated_at: "2019-04-23",
            }),
          };
        }
        return {
          status: 200,
          body: env("invoice_issuer", {
            corporate_number: null,
            name: "山田太郎",
            name_kana: null,
            name_en: null,
            trade_name: "山田商店",
            popular_name: null,
            kind: "individual",
            active: true,
            address: null,
            invoice: { ...invoiceToyota, registration_number: "T9000000000001", valid: false, cancel_date: "2025-01-01" },
            updated_at: "2025-01-02",
          }),
        };
      },
      { calls },
    );
    const a = await client.callTool({ name: "bango_get_company", arguments: { number: "1180301018771" } });
    expect((a.structuredContent as any).invoice.status).toBe("有効");
    expect((a.structuredContent as any).status).toBe("存続");
    expect((a.structuredContent as any).source).toContain("国税庁によって保証されたものではありません");

    const b = await client.callTool({ name: "bango_get_company", arguments: { number: "T9-0000-0000-0001" } });
    expect((b.structuredContent as any).issuer_type).toBe("個人事業主");
    expect((b.structuredContent as any).invoice.status).toBe("登録取消");
    expect(calls[1].url.pathname).toBe("/v1/invoice/T9000000000001");

    const c = await client.callTool({ name: "bango_get_company", arguments: { number: "トヨタ" } });
    expect(c.isError).toBe(true);
    expect((c.content as any)[0].text).toContain("bango_find_company");
  });

  it("bango_check_invoice reports per-item results including not found and bad format", async () => {
    const client = await connect((url) => {
      if (url.pathname === "/v1/invoice/T1180301018771/valid") {
        expect(url.searchParams.get("date")).toBe("2024-10-01");
        return { status: 200, body: env("invoice_validity", { registration_number: "T1180301018771", date: "2024-10-01", valid: true, registration_date: "2023-10-01", cancel_date: null, expire_date: null }) };
      }
      return { status: 404, body: { status: 404, code: "NOT_FOUND", detail: null } };
    });
    const res = await client.callTool({
      name: "bango_check_invoice",
      arguments: { registration_numbers: ["T1180301018771", "T0000000000000", "abc"], date: "2024/10/1" },
    });
    const sc = res.structuredContent as any;
    expect(res.isError).toBeFalsy();
    expect(sc.valid_count).toBe(1);
    expect(sc.results.map((r: any) => r.status)).toEqual(["有効", "登録が見つからない", "番号の形式が不正"]);
  });

  it("bango_match_companies submits, polls and returns rows", async () => {
    let polls = 0;
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const client = await connect(
      (url, init) => {
        if (url.pathname === "/v1/batch/match") {
          const body = JSON.parse(String(init.body));
          expect(body.companies).toEqual([{ name: "サンプル商事" }, { name: "テスト工業", prefecture_code: "27" }]);
          return { status: 202, body: env("batch_job", { job_id: "job1", status: "queued" }) };
        }
        if (url.pathname === "/v1/batch/job1") {
          polls++;
          return {
            status: 200,
            body: env("batch_job", polls < 2
              ? { job_id: "job1", status: "processing", progress: { done: 0, total: 2 }, summary: null, error: null }
              : { job_id: "job1", status: "completed", progress: { done: 2, total: 2 }, summary: { confident: 1, review: 1, unmatched: 0 }, error: null }),
          };
        }
        return {
          status: 200,
          body: env("list", [
            { row_index: 2, input_name: "テスト工業", prefecture_code: "27", confidence: "review", matched_corporate_number: null, score: 0.6, candidates: [
              { corporate_number: "2222222222222", name: "テスト工業株式会社", name_kana: null, score: 0.6 },
              { corporate_number: "3333333333333", name: "テスト工業有限会社", name_kana: null, score: 0.58 },
            ] },
            { row_index: 1, input_name: "サンプル商事", prefecture_code: null, confidence: "confident", matched_corporate_number: "1111111111111", score: 0.97, candidates: [
              { corporate_number: "1111111111111", name: "株式会社サンプル商事", name_kana: null, score: 0.97 },
            ] },
          ], { has_more: false }),
        };
      },
      { calls },
    );
    const res = await client.callTool({
      name: "bango_match_companies",
      arguments: { companies: ["サンプル商事", { name: "テスト工業", prefecture: "大阪" }] },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.results[0]).toMatchObject({ row: 1, confidence: "confident", matched_name: "株式会社サンプル商事" });
    expect(sc.results[1].candidates).toHaveLength(2);
    const submit = calls.find((c) => c.url.pathname === "/v1/batch/match")!;
    expect((submit.init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });

  it("bango_match_companies returns job_id when still processing", async () => {
    const client = await connect(() => ({
      status: 200,
      body: env("batch_job", { job_id: "job2", status: "processing", progress: { done: 1, total: 50 }, summary: null, error: null }),
    }));
    const res = await client.callTool({ name: "bango_match_companies", arguments: { job_id: "job2" } });
    const sc = res.structuredContent as any;
    expect(sc.status).toBe("processing");
    expect(sc.hint).toContain("job_id");
  });

  it("explains how to get an API key when it is missing", async () => {
    const client = await connect(() => ({ status: 200, body: {} }), { apiKey: null });
    const res = await client.callTool({ name: "bango_get_company", arguments: { number: "1180301018771" } });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toContain("https://bango-api.jp/signup");
  });

  it("turns quota errors into actionable messages", async () => {
    const client = await connect(() => ({ status: 429, body: { status: 429, code: "QUOTA_EXCEEDED", limit_scope: "api_requests", retry_after: 3600 } }));
    const res = await client.callTool({ name: "bango_find_company", arguments: { company_name: "サンプル" } });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toContain("今月の利用上限");
  });
});
