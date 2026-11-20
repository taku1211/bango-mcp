import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { BangoClient, BangoError, type Envelope } from "./client.js";
import { parseDate, parseIdentifier, parseRegistrationNumber } from "./normalize.js";
import { prefectureName, toPrefectureCode } from "./prefectures.js";
import { VERSION } from "./version.js";

export const SOURCE_NOTICE =
  "出典: 国税庁法人番号システム・適格請求書発行事業者公表システムのWeb-API機能を利用して取得した情報をBango APIが編集・加工したもの。内容は国税庁によって保証されたものではありません。";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ---------------------------------------------------------------------------
// API response shapes (only the fields this server reads)

type Address = {
  full: string | null;
  post_code: string | null;
  prefecture: string | null;
  prefecture_code: string | null;
  city: string | null;
};

type InvoiceStatus = {
  found: boolean;
  registered: boolean;
  valid: boolean | null;
  registration_number: string | null;
  registration_date: string | null;
  cancel_date: string | null;
  expire_date: string | null;
};

type CompanyData = {
  corporate_number: string;
  name: string;
  name_kana: string | null;
  name_en: string | null;
  kind: string | null;
  active: boolean;
  closure: { date?: string | null; cause?: string | null } | null;
  address: Address | null;
  invoice: InvoiceStatus | null;
  updated_at: string | null;
};

type InvoiceIssuerData = {
  corporate_number: string | null;
  name: string | null;
  name_kana: string | null;
  name_en: string | null;
  trade_name: string | null;
  popular_name: string | null;
  kind: string | null;
  active: boolean | null;
  address: Address | null;
  invoice: InvoiceStatus;
  updated_at: string | null;
};

type InvoiceValidity = {
  registration_number: string;
  date: string;
  valid: boolean;
  registration_date: string | null;
  cancel_date: string | null;
  expire_date: string | null;
};

type SearchHit = {
  corporate_number: string;
  name: string;
  name_kana: string | null;
  prefecture_code: string | null;
  city_code: string | null;
  score: number | null;
};

type BatchJob = {
  job_id: string;
  status: "queued" | "processing" | "completed" | "failed" | string;
  progress?: { done: number; total: number };
  summary?: { confident: number; review: number; unmatched: number };
  error?: { code: string; message: string; retryable: boolean } | null;
};

type BatchRow = {
  row_index: number;
  input_name: string;
  prefecture_code: string | null;
  confidence: "confident" | "review" | "unmatched" | string;
  matched_corporate_number: string | null;
  score: number | null;
  candidates: Array<{ corporate_number: string; name: string; name_kana: string | null; score: number | null }>;
};

// ---------------------------------------------------------------------------
// helpers

function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BangoError) return fail(error.message);
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`予期しないエラーが起きました（${reason}）。もう一度試しても直らない場合は https://github.com/taku1211/bango-mcp/issues に報告してください。`);
  }
}

function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function invoiceStatusLabel(inv: { registered?: boolean; valid: boolean | null; cancel_date: string | null; expire_date: string | null }): string {
  if (inv.registered === false) return "未登録";
  if (inv.valid) return "有効";
  if (inv.cancel_date) return "登録取消";
  if (inv.expire_date) return "失効";
  return "無効";
}

function summarizeInvoice(inv: InvoiceStatus | null) {
  if (!inv || !inv.found) {
    return { registered: false, status: "未登録", registration_number: null };
  }
  return {
    registered: inv.registered,
    status: invoiceStatusLabel(inv),
    registration_number: inv.registration_number,
    registration_date: inv.registration_date,
    cancel_date: inv.cancel_date,
    expire_date: inv.expire_date,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

export type ServerOptions = {
  client: BangoClient;
  /** 名寄せジョブの完了を待つ最大時間（ms） */
  batchWaitMs?: number;
  /** 名寄せジョブのポーリング間隔（ms） */
  batchPollMs?: number;
};

export function createServer(options: ServerOptions): McpServer {
  const { client } = options;
  const batchWaitMs = options.batchWaitMs ?? 45_000;
  const batchPollMs = options.batchPollMs ?? 1_500;

  const server = new McpServer(
    { name: "bango-mcp", title: "Bango API（法人番号・インボイス）", version: VERSION },
    {
      instructions:
        "日本の会社（法人）を特定し、法人番号・所在地・インボイス（適格請求書発行事業者）の登録状況を調べるためのツールです。" +
        "会社名しか分からないときは bango_find_company、法人番号かT番号が分かっているときは bango_get_company、" +
        "請求書のT番号が有効かを確かめたいときは bango_check_invoice、会社名の一覧に法人番号をまとめて付けたいときは bango_match_companies を使います。" +
        "候補が複数あって決めきれないときは、推測で1社に決めずにユーザーへ所在地などを確認してください。" +
        "回答で法人情報を示すときは、国税庁の公表情報をもとにしたデータであり国税庁が保証するものではないことを添えてください。",
    },
  );

  // 1) 会社名 → 候補 ----------------------------------------------------------
  server.registerTool(
    "bango_find_company",
    {
      title: "会社名から法人を探す",
      description:
        "Find Japanese companies (法人) by name and return candidate corporate numbers (法人番号). " +
        "Use this when the user gives a company name instead of a number, e.g. 「トヨタ自動車」「㈱サンプル 大阪」「sample shoji」. " +
        "Name variants are absorbed automatically (株式会社/㈱/(株), full-width/half-width, spaces), so pass the name as the user wrote it; do not guess a 13-digit number. " +
        "Narrow with prefecture when the user mentions a place. " +
        "Results are ranked by score (0-1). If several candidates look plausible, ask the user which one they mean (show name and prefecture) instead of picking one. " +
        "Then call bango_get_company with the chosen corporate_number for address and invoice status. " +
        "Each call uses 1 API request from the user's Bango API quota.",
      inputSchema: {
        company_name: z
          .string()
          .min(1)
          .max(200)
          .describe("会社名（一部でも可）。例: 「サンプル商事」「株式会社サンプル」"),
        prefecture: z
          .string()
          .optional()
          .describe("都道府県で絞り込む。「大阪」「大阪府」「27」「osaka」のどれでも可"),
        post_code: z.string().optional().describe("郵便番号（7桁、ハイフン可）で絞り込む"),
        exact: z
          .boolean()
          .optional()
          .describe("true にすると表記ゆれを吸収したうえでの完全一致だけを返す。既定は部分一致（false）"),
        limit: z.number().int().min(1).max(20).optional().describe("返す候補の数（1〜20、既定5）"),
      },
      annotations: { title: "会社名から法人を探す", ...READ_ONLY },
    },
    async ({ company_name, prefecture, post_code, exact, limit }) =>
      guard(async () => {
        let prefecture_code: string | undefined;
        if (prefecture) {
          const code = toPrefectureCode(prefecture);
          if (!code) {
            return fail(`都道府県「${prefecture}」を解釈できませんでした。「東京都」「大阪」「13」のように指定するか、prefecture を省略してください。`);
          }
          prefecture_code = code;
        }
        let pc: string | undefined;
        if (post_code) {
          pc = post_code.normalize("NFKC").replace(/[^0-9]/g, "");
          if (pc.length !== 7) return fail(`郵便番号「${post_code}」は7桁の数字で指定してください（例: 100-0001）。`);
        }
        const res = await client.get<SearchHit[]>("/companies/search", {
          q: company_name,
          mode: exact ? "exact" : "partial",
          prefecture_code,
          post_code: pc,
          limit: limit ?? 5,
        });
        const candidates = res.data.map((h) => ({
          corporate_number: h.corporate_number,
          name: h.name,
          name_kana: h.name_kana,
          prefecture: prefectureName(h.prefecture_code),
          score: h.score,
        }));
        let hint: string;
        if (candidates.length === 0) {
          hint =
            "該当なし。会社名を短くする（「株式会社」や支店名を外す）、都道府県の絞り込みを外す、カナで試す、のいずれかで再検索してください。個人事業主は法人番号を持たないため見つかりません。";
        } else if (candidates.length === 1) {
          hint = "候補は1件です。詳しい所在地やインボイス登録状況は bango_get_company で確認できます。";
        } else {
          hint =
            "候補が複数あります。名前と都道府県をユーザーに示して確認するか、所在地が分かれば prefecture / post_code で絞り込んでください。";
        }
        return ok({
          query: { company_name, prefecture: prefecture_code ? prefectureName(prefecture_code) : null, exact: !!exact },
          candidates,
          has_more: !!res.has_more,
          hint,
        });
      }),
  );

  // 2) 番号 → 詳細 ------------------------------------------------------------
  server.registerTool(
    "bango_get_company",
    {
      title: "法人番号・T番号から会社情報を調べる",
      description:
        "Look up one Japanese company or invoice issuer by its corporate number (法人番号, 13 digits) or invoice registration number (登録番号, 'T' + 13 digits). " +
        "Hyphens, spaces and full-width digits are accepted, e.g. 「T1-1803-0101-8771」. " +
        "Returns official name, kana, address, whether the company is still active (閉鎖の有無), and its invoice registration status (有効/失効/登録取消/未登録). " +
        "T-numbers of sole proprietors (個人事業主) also work, but personal address is returned only if the person chose to publish it. " +
        "If you only have a company name, call bango_find_company first. Uses 1 API request.",
      inputSchema: {
        number: z.string().min(1).max(40).describe("法人番号（13桁）またはインボイス登録番号（T+13桁）"),
        response_format: z
          .enum(["concise", "detailed"])
          .optional()
          .describe("concise（既定）は要点だけ。detailed はAPIの全項目（英語名、変更履歴など）も含める"),
      },
      annotations: { title: "法人番号・T番号から会社情報を調べる", ...READ_ONLY },
    },
    async ({ number, response_format }) =>
      guard(async () => {
        const id = parseIdentifier(number);
        if (!id) {
          return fail(
            `「${number}」は法人番号（13桁の数字）にもインボイス登録番号（Tで始まる14文字）にも見えません。番号を確認するか、会社名なら bango_find_company を使ってください。`,
          );
        }
        if (id.kind === "corporate_number") {
          const res = await client.get<CompanyData>(`/companies/${id.value}`);
          const d = res.data;
          const out: Record<string, unknown> = {
            corporate_number: d.corporate_number,
            name: d.name,
            name_kana: d.name_kana,
            kind: d.kind,
            status: d.active ? "存続" : "閉鎖",
            closure: d.active ? null : d.closure,
            address: d.address?.full ?? null,
            post_code: d.address?.post_code ?? null,
            invoice: summarizeInvoice(d.invoice),
            data_updated_at: d.updated_at,
            source: SOURCE_NOTICE,
          };
          if (response_format === "detailed") out.raw = d;
          return ok(out);
        }
        const res = await client.get<InvoiceIssuerData>(`/invoice/${id.value}`);
        const d = res.data;
        const out: Record<string, unknown> = {
          registration_number: id.value,
          corporate_number: d.corporate_number,
          name: d.name,
          trade_name: d.trade_name,
          popular_name: d.popular_name,
          issuer_type: d.kind === "individual" ? "個人事業主" : d.kind === "corporation" ? "法人" : d.kind,
          address: d.address?.full ?? null,
          invoice: summarizeInvoice(d.invoice),
          data_updated_at: d.updated_at,
          source: SOURCE_NOTICE,
        };
        if (response_format === "detailed") out.raw = d;
        return ok(out);
      }),
  );

  // 3) T番号の有効性 ----------------------------------------------------------
  server.registerTool(
    "bango_check_invoice",
    {
      title: "インボイス登録番号が有効か確かめる",
      description:
        "Check whether invoice registration numbers (適格請求書発行事業者の登録番号, T + 13 digits) are valid, for one or many numbers at once (up to 20). " +
        "Typical use: verifying the T-number printed on an invoice or receipt before claiming input tax credit (仕入税額控除). " +
        "Without `date`, checks validity as of today (JST) and also returns the registered name so the user can compare it with the invoice. " +
        "With `date` (e.g. the invoice issue date), checks validity on that date; the name is not returned in that mode. " +
        "A number with only 13 digits is treated as a T-number. Invalid or unknown numbers are reported per item and do not fail the whole call. " +
        "Uses 1 API request per number.",
      inputSchema: {
        registration_numbers: z
          .array(z.string().min(1).max(40))
          .min(1)
          .max(20)
          .describe("確認したい登録番号の配列（1〜20件）。例: [\"T1180301018771\"]"),
        date: z
          .string()
          .optional()
          .describe("この日付時点で有効だったかを判定する（YYYY-MM-DD、2024/10/1 なども可）。省略時は今日"),
      },
      annotations: { title: "インボイス登録番号が有効か確かめる", ...READ_ONLY },
    },
    async ({ registration_numbers, date }) =>
      guard(async () => {
        let isoDate: string | undefined;
        if (date) {
          const parsed = parseDate(date);
          if (!parsed) return fail(`日付「${date}」を解釈できませんでした。2024-10-01 のように指定してください。`);
          isoDate = parsed;
        }
        const results = await mapLimit(registration_numbers, 5, async (input) => {
          const reg = parseRegistrationNumber(input);
          if (!reg) {
            return { input, registration_number: null, status: "番号の形式が不正", valid: false };
          }
          try {
            if (isoDate) {
              const res = await client.get<InvoiceValidity>(`/invoice/${reg}/valid`, { date: isoDate });
              const v = res.data;
              return {
                input,
                registration_number: reg,
                checked_date: v.date,
                valid: v.valid,
                status: invoiceStatusLabel(v),
                registration_date: v.registration_date,
                cancel_date: v.cancel_date,
                expire_date: v.expire_date,
              };
            }
            const res = await client.get<InvoiceIssuerData>(`/invoice/${reg}`);
            const inv = res.data.invoice;
            return {
              input,
              registration_number: reg,
              checked_date: todayJst(),
              valid: !!inv.valid,
              status: invoiceStatusLabel(inv),
              name: res.data.name ?? res.data.trade_name ?? null,
              registration_date: inv.registration_date,
              cancel_date: inv.cancel_date,
              expire_date: inv.expire_date,
            };
          } catch (error) {
            if (error instanceof BangoError && error.status === 404) {
              return { input, registration_number: reg, status: "登録が見つからない", valid: false };
            }
            throw error;
          }
        });
        const validCount = results.filter((r) => r.valid).length;
        return ok({
          checked: results.length,
          valid_count: validCount,
          invalid_count: results.length - validCount,
          results,
          source: SOURCE_NOTICE,
        });
      }),
  );

  // 4) 会社名リスト → 法人番号（名寄せ） ---------------------------------------
  server.registerTool(
    "bango_match_companies",
    {
      title: "会社名の一覧に法人番号をまとめて付ける（名寄せ）",
      description:
        "Match a list of company names (e.g. a customer list, sales list, or vendor master from a spreadsheet) to corporate numbers in one go (名寄せ). " +
        "Each row gets a confidence: 'confident' (safe to use), 'review' (several close candidates; show them to the user), or 'unmatched'. " +
        "Pass up to 50 names per call; adding a prefecture per row improves accuracy. " +
        "The job usually finishes within seconds. If it is still running when this tool returns, call it again with the returned job_id (and no companies) to fetch the result; do not resubmit the list. " +
        "Uses batch-row quota (Free plan: 50 rows per month). For a single company, bango_find_company is cheaper.",
      inputSchema: {
        companies: z
          .array(
            z.union([
              z.string().min(1).max(200),
              z.object({
                name: z.string().min(1).max(200).describe("会社名"),
                prefecture: z.string().optional().describe("都道府県（「東京」「13」など）"),
              }),
            ]),
          )
          .min(1)
          .max(50)
          .optional()
          .describe("会社名の配列（1〜50件）。文字列か {name, prefecture} の形"),
        job_id: z.string().min(1).max(64).optional().describe("前回の呼び出しで返った job_id。結果の取得だけを行う"),
      },
      annotations: { title: "会社名の一覧に法人番号をまとめて付ける", ...READ_ONLY },
    },
    async ({ companies, job_id }) =>
      guard(async () => {
        if (!companies && !job_id) return fail("companies（会社名の配列）か job_id のどちらかを指定してください。");
        if (companies && job_id) return fail("companies と job_id は同時に指定できません。結果の取得だけなら job_id のみを渡してください。");

        let jobId = job_id;
        if (companies) {
          const payload: Array<{ name: string; prefecture_code?: string }> = [];
          for (const [i, c] of companies.entries()) {
            if (typeof c === "string") {
              payload.push({ name: c });
              continue;
            }
            if (c.prefecture) {
              const code = toPrefectureCode(c.prefecture);
              if (!code) return fail(`${i + 1}件目の都道府県「${c.prefecture}」を解釈できませんでした。「東京都」「13」のように指定してください。`);
              payload.push({ name: c.name, prefecture_code: code });
            } else {
              payload.push({ name: c.name });
            }
          }
          const body = { companies: payload };
          const submitted = await client.post<BatchJob>("/batch/match", body, { "Idempotency-Key": randomUUID() });
          jobId = submitted.data.job_id;
        }

        const deadline = Date.now() + batchWaitMs;
        let job: Envelope<BatchJob>;
        for (;;) {
          job = await client.get<BatchJob>(`/batch/${jobId}`);
          if (job.data.status === "completed" || job.data.status === "failed") break;
          if (Date.now() + batchPollMs > deadline) {
            return ok({
              job_id: jobId,
              status: job.data.status,
              progress: job.data.progress ?? null,
              hint: "まだ処理中です。少し待ってから、同じ job_id だけを渡してこのツールをもう一度呼んでください（リストを再送しないでください）。",
            });
          }
          await sleep(batchPollMs);
        }
        if (job.data.status === "failed") {
          const e = job.data.error;
          return fail(
            `名寄せジョブが失敗しました（job_id: ${jobId}${e ? `、${e.code}: ${e.message}` : ""}）。` +
              (e?.retryable === false ? "入力を見直してから、会社名の一覧を送り直してください。" : "少し待ってから、会社名の一覧をもう一度送ってください。"),
          );
        }

        const download = await client.get<BatchRow[]>(`/batch/${jobId}/download`, { format: "json" });
        const rows: BatchRow[] = [...download.data];

        const results = rows
          .sort((a, b) => a.row_index - b.row_index)
          .map((r) => {
            const matched = r.candidates.find((c) => c.corporate_number === r.matched_corporate_number);
            const base = {
              row: r.row_index,
              input_name: r.input_name,
              prefecture: prefectureName(r.prefecture_code),
              confidence: r.confidence,
              corporate_number: r.matched_corporate_number,
              matched_name: matched?.name ?? null,
              score: r.score,
            };
            if (r.confidence === "review") {
              return { ...base, candidates: r.candidates.slice(0, 3).map((c) => ({ corporate_number: c.corporate_number, name: c.name, score: c.score })) };
            }
            return base;
          });

        return ok({
          job_id: jobId,
          status: "completed",
          summary: job.data.summary ?? null,
          results,
          hint: "confident はそのまま使える一致、review は候補をユーザーに確認、unmatched は社名の表記を変えて bango_find_company で再検索してください。",
          source: SOURCE_NOTICE,
        });
      }),
  );

  return server;
}
