import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { BangoClient, BangoError, type Envelope, LISTS_URL, PRICING_URL } from "./client.js";
import { parseDate, parseIdentifier, parseRegistrationNumber } from "./normalize.js";
import { toCityCode } from "./cities.js";
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

export const LIST_SOURCE_NOTICE =
  "出典: 法人番号・所在地は国税庁法人番号システムのWeb-API機能を利用して取得した情報をBango APIが編集・加工したもの（国税庁が保証するものではありません）。公式サイトURL・業種は各行の source（公的名簿・Common Crawl など）と観測日をもとにした推定を含みます。出典を表示すれば、納品・組み込みを含む商用利用ができます。";

const INDUSTRY_MAJORS = [
  "建設",
  "製造",
  "卸売",
  "小売",
  "不動産",
  "運輸・物流",
  "情報通信・IT",
  "医療",
  "介護・福祉・保育",
  "教育・学習支援",
  "士業・専門サービス",
  "飲食",
  "宿泊",
  "生活関連サービス",
  "広告・制作・コンサル",
  "金融・保険",
  "農林水産",
  "エネルギー",
  "その他サービス",
  "団体・非営利",
  "宗教",
] as const;

type CompanyCount = {
  total: number;
  with_website: number;
  with_phone: number;
  with_contact_form: number;
  by_industry_major: Array<{ industry_major: string; count: number }>;
  excluded: number;
  already_delivered_this_month: number;
  quota_needed: number;
};

type ProfileExport = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  row_count: number;
  contact_detail_included: boolean;
  stopped_reason: "requested_rows" | "end" | "quota" | null;
  error_code: string | null;
  download_url: string | null;
};

type ProfileRow = {
  corporate_number: string;
  name: string;
  post_code: string | null;
  address: { prefecture: string | null; city: string | null; street: string | null } | null;
  web: { url: string; status: string; source: string | null; observed_at: string | null } | null;
  industry: {
    major: string;
    minor: string | null;
    basis: string;
    source: string | null;
    jsic: { code: string; name: string } | null;
  } | null;
  // 電話・問い合わせフォーム。API が返す形のまま渡す（Free は有無だけ、Starter 以上は値まで）。
  contact?: {
    has_phone?: boolean;
    has_contact_form?: boolean;
    phone?: { number?: string } | null;
    form_url?: string | null;
    has_fax?: boolean;
    fax?: { number?: string } | null;
    source?: string | null;
  } | null;
  established?: { year_month: string | null } | null;
  insured_employees?: { count: number | null; band: string | null; source: string | null } | null;
};

type CompanyRow = ReturnType<typeof toCompanyRow>;

function toCompanyRow(p: ProfileRow) {
  return {
    corporate_number: p.corporate_number,
    name: p.name,
    prefecture: p.address?.prefecture ?? null,
    city: p.address?.city ?? null,
    street: p.address?.street ?? null,
    post_code: p.post_code,
    website: p.web
      ? { url: p.web.url, status: p.web.status, source: p.web.source, observed_at: p.web.observed_at?.slice(0, 10) ?? null }
      : null,
    industry: p.industry
      ? {
          major: p.industry.major,
          minor: p.industry.minor,
          jsic_code: p.industry.jsic?.code ?? null,
          jsic_name: p.industry.jsic?.name ?? null,
          basis: p.industry.basis,
          source: p.industry.source,
        }
      : null,
    ...(p.contact !== undefined ? { contact: p.contact } : {}),
    ...(p.established ? { established_year_month: p.established.year_month } : {}),
    ...(p.insured_employees ? { insured_employees: p.insured_employees } : {}),
  };
}

// 列の並び・見出しは API の範囲検索CSV（houjin-search apps/api/src/company-profiles/csv.ts）と同じにする。
const CSV_HEADER = [
  "法人番号", "法人名", "都道府県", "市区町村", "番地", "郵便番号",
  "公式サイトURL", "URLの確認状態", "URLの出典", "URLの観測日",
  "業種(大分類)", "業種(細分類)", "日本標準産業分類コード", "日本標準産業分類名", "業種の根拠", "業種の出典",
  "電話番号あり", "問い合わせフォームあり", "電話番号", "問い合わせフォームURL", "FAX番号あり", "FAX番号", "連絡先の出典",
  "設立年月(推定)", "被保険者数(厚生年金)", "被保険者数の規模帯", "被保険者数の出典",
];

function csvCell(raw: string | null | undefined): string {
  let v = raw ?? "";
  if (/^[=+\-@]/.test(v)) v = `'${v}`; // 表計算での数式実行を防ぐ
  return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

function yesNo(v: boolean | undefined): string {
  return v === undefined ? "" : v ? "あり" : "なし";
}

function toCsv(rows: CompanyRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of rows) {
    const c = r.contact ?? null;
    const e = r.insured_employees ?? null;
    lines.push(
      [
        r.corporate_number, r.name, r.prefecture, r.city, r.street, r.post_code,
        r.website?.url, r.website?.status, r.website?.source, r.website?.observed_at,
        r.industry?.major, r.industry?.minor, r.industry?.jsic_code, r.industry?.jsic_name, r.industry?.basis, r.industry?.source,
        yesNo(c?.has_phone), yesNo(c?.has_contact_form), c?.phone?.number, c?.form_url, yesNo(c?.has_fax), c?.fax?.number, c?.source,
        r.established_year_month, e?.count == null ? null : String(e.count), e?.band, e?.source,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

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


// 範囲検索・件数・CSV書き出しで共通の絞り込み入力。
const FILTER_INPUT = {
  prefecture: z.string().optional().describe("都道府県。「大阪」「大阪府」「27」「osaka」のどれでも可"),
  city: z
    .string()
    .optional()
    .describe("市区町村。政令指定都市は名前（大阪市・横浜市・東京23区など）で全区が対象。それ以外は5桁の全国地方公共団体コード（例: 27203 豊中市）"),
  post_code_prefix: z.string().optional().describe("郵便番号の前方一致（3〜7桁、ハイフン可）。例: 530 / 591-0001"),
  industry: z.enum(INDUSTRY_MAJORS).optional().describe("業種の大分類（推定値）。工務店・建設会社は「建設」、介護事業所は「介護・福祉・保育」"),
  jsic_code: z
    .string()
    .regex(/^\d{2}$/)
    .optional()
    .describe("日本標準産業分類（第14回改定）の中分類2桁。例: 06 総合工事業、85 社会保険・社会福祉・介護事業"),
  has_website: z.boolean().optional().describe("true で公式サイトURLがある会社だけ、false でない会社だけ"),
  verified_only: z.boolean().optional().describe("true でサイト自身が社名を名乗っている根拠のあるURLだけに絞る"),
  has_phone: z.boolean().optional().describe("true で電話番号がある会社だけ"),
  has_contact_form: z.boolean().optional().describe("true で問い合わせフォームがある会社だけ（フォーム営業向け）"),
};

type FilterArgs = {
  prefecture?: string;
  city?: string;
  post_code_prefix?: string;
  industry?: string;
  jsic_code?: string;
  has_website?: boolean;
  verified_only?: boolean;
  has_phone?: boolean;
  has_contact_form?: boolean;
};

type ResolvedFilters =
  | { ok: true; params: Record<string, string | boolean | undefined>; query: Record<string, unknown> }
  | { ok: false; message: string };

// 人が言う「大阪市」「大阪」などを API のコードに直す。直せないときは次に何を渡せばよいかを返す。
function resolveFilters({ prefecture, city, post_code_prefix, industry, jsic_code, has_website, verified_only, has_phone, has_contact_form }: FilterArgs): ResolvedFilters {
  const bad = (message: string): ResolvedFilters => ({ ok: false, message });
  let prefecture_code: string | undefined;
  if (prefecture) {
    const code = toPrefectureCode(prefecture);
    if (!code) return bad(`都道府県「${prefecture}」を解釈できませんでした。「東京都」「大阪」「13」のように指定してください。`);
    prefecture_code = code;
  }
  let city_code: string | undefined;
  if (city) {
    const code = toCityCode(city);
    if (!code) {
      return bad(
        `市区町村「${city}」をコードにできませんでした。政令指定都市（大阪市・横浜市・東京23区など）は名前で、それ以外の市区町村は5桁の全国地方公共団体コード（例: 27203 豊中市）で指定してください。`,
      );
    }
    city_code = code;
  }
  let pc: string | undefined;
  if (post_code_prefix) {
    pc = post_code_prefix.normalize("NFKC").replace(/[^0-9]/g, "");
    if (pc.length < 3 || pc.length > 7) return bad(`郵便番号「${post_code_prefix}」は先頭3〜7桁で指定してください（例: 530）。`);
  }
  if (!prefecture_code && !city_code && !pc && !industry && !jsic_code) {
    return bad("エリア（prefecture / city / post_code_prefix）か業種（industry / jsic_code）のどれか1つを指定してください。");
  }
  return {
    ok: true,
    params: {
      prefecture_code,
      city_code,
      post_code_prefix: pc,
      industry_major: industry,
      jsic_code,
      has_website,
      web_status: verified_only ? "verified" : undefined,
      has_phone: has_phone || undefined,
      has_contact_form: has_contact_form || undefined,
    },
    query: {
      prefecture: prefecture_code ? prefectureName(prefecture_code) : null,
      city_code: city_code ?? null,
      post_code_prefix: pc ?? null,
      industry: industry ?? null,
      jsic_code: jsic_code ?? null,
      has_website: has_website ?? null,
      verified_only: !!verified_only,
      has_phone: !!has_phone,
      has_contact_form: !!has_contact_form,
    },
  };
}

export function createServer(options: ServerOptions): McpServer {
  const { client } = options;
  const batchWaitMs = options.batchWaitMs ?? 45_000;
  const batchPollMs = options.batchPollMs ?? 1_500;

  const server = new McpServer(
    { name: "bango-mcp", title: "Bango API（法人番号・インボイス・会社リスト）", version: VERSION },
    {
      instructions:
        "日本の会社（法人）を特定し、法人番号・所在地・インボイス（適格請求書発行事業者）の登録状況を調べるためのツールです。" +
        "会社名しか分からないときは bango_find_company、法人番号かT番号が分かっているときは bango_get_company、" +
        "請求書のT番号が有効かを確かめたいときは bango_check_invoice、会社名の一覧に法人番号をまとめて付けたいときは bango_match_companies、" +
        "エリアや業種で会社のリストを作りたいときは、まず bango_count_companies で件数と内訳を伝え（無料・枠を使わない）、" +
        "中身を見たいと言われたら bango_list_companies で数社だけ見せ、まとまった数をCSVで欲しいときは bango_export_companies_csv でダウンロードリンクを渡します（行をチャットに並べない）。" +
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

  // 5) エリア・業種 → 会社リスト ------------------------------------------------
  server.registerTool(
    "bango_list_companies",
    {
      title: "エリア・業種で会社のリストを作る",
      description:
        "List Japanese companies (法人) by area and industry, with official website URL and industry, each carrying its source and observation date. " +
        "Use this for requests like 「大阪市の工務店で公式サイトがある会社をリストにして」「堺市の介護事業所を100社CSVで」. " +
        "Give at least one of prefecture, city, post_code_prefix, industry or jsic_code. " +
        "city accepts a designated city name (大阪市, 横浜市, 東京23区 ...) which covers all its wards, or a 5-digit local government code for any other city. " +
        "Results are ordered by corporate number; when next_cursor is not null, call again with cursor to get the next page. " +
        "Set format to csv to also receive a ready-to-save CSV (UTF-8, CRLF). " +
        "Phone and contact form: on the Free plan only has_phone / has_contact_form are filled; Starter and above also return the number and the form URL. " +
        "Each company returned counts against the user's monthly company quota for list search (remaining_this_month), separately from API requests. " +
        "Ask for only as many companies as the user needs.",
      inputSchema: {
        ...FILTER_INPUT,
        limit: z.number().int().min(1).max(100).optional().describe("1回に返す社数（1〜100、既定20）。返した社数だけ月間の社数枠を使う"),
        cursor: z.string().regex(/^\d{13}$/).optional().describe("前回の next_cursor。続きのページを取るときに渡す"),
        format: z.enum(["rows", "csv"]).optional().describe("csv にすると、表と一緒に保存用のCSV文字列（csv）も返す"),
      },
      annotations: { title: "エリア・業種で会社のリストを作る", ...READ_ONLY },
    },
    async ({ prefecture, city, post_code_prefix, industry, jsic_code, has_website, verified_only, has_phone, has_contact_form, limit, cursor, format }) =>
      guard(async () => {
        const resolved = resolveFilters({ prefecture, city, post_code_prefix, industry, jsic_code, has_website, verified_only, has_phone, has_contact_form });
        if (!resolved.ok) return fail(resolved.message);
        const { params, query } = resolved;

        const res = await client.get<ProfileRow[]>("/companies/profiles", { ...params, limit: limit ?? 20, cursor });

        const companies = res.data.map(toCompanyRow);
        const quota = res.meta?.quota?.profile_rows;
        const remaining = quota && !quota.unlimited ? quota.remaining : null;
        const next = res.next_cursor ?? null;
        let hint: string;
        if (companies.length === 0) {
          hint = "該当なし。業種を外す、市区町村を都道府県に広げる、has_website を外す、のいずれかで再検索してください。";
        } else if (next) {
          hint = `続きがあります。ユーザーがもっと必要なら cursor に "${next}" を渡して同じ条件で呼び出してください。`;
        } else {
          hint = "これで条件に合う会社はすべてです。";
        }
        return ok({
          query,
          companies,
          ...(format === "csv" ? { csv: toCsv(companies) } : {}),
          has_more: !!res.has_more,
          next_cursor: next,
          remaining_this_month: remaining,
          hint,
          source_notice: LIST_SOURCE_NOTICE,
        });
      }),
  );

  // 6) エリア・業種 → 件数と内訳（無料） ------------------------------------------
  server.registerTool(
    "bango_count_companies",
    {
      title: "エリア・業種に合う会社の数を数える（無料）",
      description:
        "Count Japanese companies matching an area / industry before making a list, with a breakdown (with website, with phone, with contact form, by industry). " +
        "Free: it does not use the monthly company quota, so call it first whenever the user asks for a list, and tell them the count before fetching rows. " +
        "Also returns how many of them were already delivered this month (re-delivering them is free) and how many quota rows a full export would use. " +
        "Takes the same filters as bango_list_companies.",
      inputSchema: { ...FILTER_INPUT },
      annotations: { title: "エリア・業種に合う会社の数を数える", ...READ_ONLY },
    },
    async (args) =>
      guard(async () => {
        const resolved = resolveFilters(args);
        if (!resolved.ok) return fail(resolved.message);
        const res = await client.get<CompanyCount>("/companies/profiles/count", resolved.params);
        const quota = res.meta?.quota?.profile_rows;
        const remaining = quota && !quota.unlimited ? quota.remaining : null;
        const c = res.data;
        return ok({
          query: resolved.query,
          total: c.total,
          with_website: c.with_website,
          with_phone: c.with_phone,
          with_contact_form: c.with_contact_form,
          by_industry: c.by_industry_major.slice(0, 10),
          already_delivered_this_month: c.already_delivered_this_month,
          quota_needed_for_all: c.quota_needed,
          remaining_this_month: remaining,
          hint:
            c.total === 0
              ? "該当なし。業種を外す、市区町村を都道府県に広げる、has_* の条件を外す、のどれかで数え直してください。"
              : "件数をユーザーに伝えてください。中身を見たいなら bango_list_companies を limit 5 程度で、CSVで全部欲しいなら bango_export_companies_csv を使います" +
                (remaining !== null && c.quota_needed > remaining
                  ? `（今月の残り枠は ${remaining} 社なので、全件は入りません。何社にするかユーザーに確認してください）。`
                  : "。"),
          source_notice: LIST_SOURCE_NOTICE,
        });
      }),
  );

  // 7) エリア・業種 → CSVのダウンロードリンク ------------------------------------
  server.registerTool(
    "bango_export_companies_csv",
    {
      title: "エリア・業種の会社リストをCSVで書き出す",
      description:
        "Export a company list (same filters as bango_list_companies) as a CSV file and return a download link valid for 24 hours, instead of putting rows in the chat. " +
        "Use this when the user wants more than a handful of companies or asks for a CSV / Excel file. Count first with bango_count_companies and agree on max_rows. " +
        "Each newly delivered company uses the monthly company quota once per month; companies already delivered this month are free. If the quota runs out midway, the CSV contains what fit. " +
        "The export runs in the background: if status is still running, call again with only export_id. " +
        "On the Free plan the CSV has phone / contact form as あり/なし only; Starter and above include the number and the form URL.",
      inputSchema: {
        ...FILTER_INPUT,
        max_rows: z.number().int().min(1).max(100000).optional().describe("書き出す最大社数（1〜100000）。新しく始めるときは必須"),
        export_id: z.string().uuid().optional().describe("前回の export_id。処理中だった書き出しの結果を取りに来るときは、これだけを渡す"),
      },
      annotations: {
        title: "エリア・業種の会社リストをCSVで書き出す",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ export_id, max_rows, ...filters }) =>
      guard(async () => {
        let id = export_id;
        if (!id) {
          if (max_rows === undefined) return fail("max_rows（書き出す社数）を指定してください。先に bango_count_companies で件数を確かめると決めやすいです。");
          const resolved = resolveFilters(filters);
          if (!resolved.ok) return fail(resolved.message);
          const body = Object.fromEntries(
            Object.entries(resolved.params)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, String(v)]),
          );
          const started = await client.post<ProfileExport>("/companies/profiles/exports", { filters: body, max_rows });
          id = started.data.id;
        }

        const deadline = Date.now() + batchWaitMs;
        let job: ProfileExport;
        for (;;) {
          job = (await client.get<ProfileExport>(`/companies/profiles/exports/${id}`)).data;
          if (job.status === "succeeded" || job.status === "failed") break;
          if (Date.now() + batchPollMs > deadline) {
            return ok({
              export_id: id,
              status: job.status,
              rows_so_far: job.row_count,
              hint: "まだ作成中です。少し待ってから、同じ export_id だけを渡してこのツールをもう一度呼んでください（条件を送り直さないでください）。",
            });
          }
          await sleep(batchPollMs);
        }
        if (job.status === "failed") {
          return fail(
            job.error_code === "quota_exceeded"
              ? `今月の社数枠を使い切っているため、CSVを作れませんでした。来月まで待つか、プランを上げると続けられます（${PRICING_URL}）。`
              : "CSVを作れませんでした。少し待ってから、条件を指定してもう一度書き出してください。",
          );
        }
        const stoppedByQuota = job.stopped_reason === "quota";
        return ok({
          export_id: id,
          status: "succeeded",
          rows: job.row_count,
          download_url: job.download_url,
          download_expires_in_hours: job.download_url ? 24 : null,
          contact_detail_included: job.contact_detail_included,
          stopped_by_quota: stoppedByQuota,
          hint:
            (job.download_url
              ? "download_url をそのままユーザーに渡してください（24時間有効。開くとCSVが保存されます。Excelでも文字化けしません）。"
              : `ダウンロードリンクを作れなかったので、${LISTS_URL} の画面から同じ条件で書き出すよう案内してください。`) +
            (stoppedByQuota ? " 今月の社数枠に達したため、入った分までのCSVです。" : "") +
            (job.contact_detail_included ? "" : ` Freeプランなので電話番号・フォームは「あり/なし」だけです。Starter以上なら値も入ります（${PRICING_URL}）。`),
          source_notice: LIST_SOURCE_NOTICE,
        });
      }),
  );

  return server;
}
