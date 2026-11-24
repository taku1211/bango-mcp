import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.bango-api.jp/v1";
export const SIGNUP_URL = "https://bango-api.jp/signup";
export const API_KEYS_URL = "https://bango-api.jp/dashboard/api-keys";
export const PRICING_URL = "https://bango-api.jp/pricing";
export const LISTS_URL = "https://bango-api.jp/dashboard/lists";

/** Bango API の応答エンベロープ（必要な部分だけ） */
export type Envelope<T> = {
  object: string;
  data: T;
  has_more?: boolean;
  next_cursor?: string | null;
  meta?: {
    quota?: {
      api_requests?: { limit: number | null; remaining: number | null; unlimited: boolean } | null;
      batch_rows?: { limit: number | null; remaining: number | null; unlimited: boolean } | null;
      /** エリア・業種リスト（/companies/profiles）で返した社数の月間枠 */
      profile_rows?: { limit: number | null; remaining: number | null; unlimited: boolean } | null;
    };
    source?: { name: string; updated_at: string | null };
  };
};

/** エージェントがそのまま次の行動を決められるように、原因と対処を文章で持つエラー */
export class BangoError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "BangoError";
  }
}

type Problem = {
  status?: number;
  code?: string | null;
  title?: string;
  detail?: string | null;
  limit_scope?: string | null;
  retry_after?: number | null;
  details?: unknown;
};

export type BangoClientOptions = {
  apiKey: string | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** リモート版は別の User-Agent を名乗り、API 側のログでローカル版と区別して数えられるようにする */
  userAgent?: string;
  /** APIキーが無効になったときの案内。リモート版は「キーを設定し直す」ではなく「再接続」を案内する */
  invalidKeyHint?: string;
  /** GET が 503 のときに取り直すまでの待ち時間（ミリ秒）。要素数が取り直しの回数 */
  retryDelaysMs?: readonly number[];
};

export class BangoClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly invalidKeyHint: string;
  private readonly retryDelaysMs: readonly number[];

  constructor(options: BangoClientOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.userAgent = options.userAgent ?? `bango-mcp/${VERSION} (+https://github.com/taku1211/bango-mcp)`;
    this.retryDelaysMs = options.retryDelaysMs ?? [500, 1500];
    this.invalidKeyHint = options.invalidKeyHint ?? `${API_KEYS_URL} でキーを確認し、BANGO_API_KEY を設定し直してください。`;
  }

  async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<Envelope<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    // 検索の同時実行枠が一瞬埋まっただけの 503 は、読み取りなので少し待って取り直す
    // （MCP クライアントは複数のツールを同時に呼ぶことがある）。
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request<T>(url, { method: "GET" });
      } catch (error) {
        const delay = this.retryDelaysMs[attempt];
        if (!(error instanceof BangoError) || error.status !== 503 || delay === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<Envelope<T>> {
    return this.request<T>(new URL(this.baseUrl + path), {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    });
  }

  private async request<T>(url: URL, init: RequestInit): Promise<Envelope<T>> {
    if (!this.apiKey) {
      throw new BangoError(
        "BANGO_API_KEY が設定されていません。Bango API の無料プランに登録し（" +
          SIGNUP_URL +
          "）、APIキー（" +
          API_KEYS_URL +
          "）を MCP クライアントの設定で環境変数 BANGO_API_KEY に入れてください。",
        null,
        "MISSING_API_KEY",
      );
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          accept: "application/json",
          "x-api-key": this.apiKey,
          "user-agent": this.userAgent,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new BangoError(
        `Bango API に接続できませんでした（${reason}）。少し待ってから同じ呼び出しをもう一度試してください。`,
        null,
        "NETWORK_ERROR",
      );
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw toBangoError(res.status, (json ?? {}) as Problem, this.invalidKeyHint, url.pathname.slice(new URL(this.baseUrl).pathname.replace(/\/+$/, "").length));
    }
    return json as Envelope<T>;
  }
}

const PROFILES_PATH = "/companies/profiles";

function toBangoError(status: number, p: Problem, invalidKeyHint: string, path = ""): BangoError {
  const code = p.code ?? null;
  const detail = p.detail ? `（${p.detail}）` : "";
  switch (status) {
    case 401:
      return new BangoError(
        `APIキーが無効です${detail}。${invalidKeyHint}`,
        status,
        code,
      );
    case 402:
    case 403:
      return new BangoError(
        `この操作は現在のプランでは使えません${detail}。プランは ${PRICING_URL} で確認できます。`,
        status,
        code,
      );
    case 404:
      // エリア・業種リスト（範囲検索）は API 側の設定で止められる。止まっている間は
      // ルート自体が無くなり 404 になるので、「データが無い」ではなく停止中と伝える。
      if (path === PROFILES_PATH || path.startsWith(`${PROFILES_PATH}/`)) {
        const exportLookup = path.startsWith(`${PROFILES_PATH}/exports/`);
        return new BangoError(
          exportLookup
            ? "この書き出しが見つかりません。エリア・業種のリスト機能が一時停止中か、書き出しの期限が切れています。会社名での検索（bango_find_company）や法人番号での照会は使えます。"
            : "エリア・業種のリスト機能は現在一時停止中です。再開まで、会社名での検索（bango_find_company）や法人番号での照会（bango_get_company）をお使いください。",
          status,
          "LIST_SEARCH_PAUSED",
        );
      }
      return new BangoError(
        `該当するデータが見つかりませんでした${detail}。番号の打ち間違いがないか確認するか、会社名なら bango_find_company で検索してください。`,
        status,
        code,
      );
    case 400:
    case 422:
      return new BangoError(`入力が正しくありません${detail}。${formatDetails(p.details)}`.trim(), status, code);
    case 429: {
      const wait = p.retry_after ? `${p.retry_after}秒ほど待ってから` : "しばらく待ってから";
      if (code === "QUOTA_EXCEEDED" && p.limit_scope === "profile_rows") {
        return new BangoError(
          `今月のエリア・業種リストの社数枠を使い切りました${detail}。枠は月初にリセットされます。社数を増やす場合は ${PRICING_URL} で上位プランを確認してください。`,
          status,
          code,
        );
      }
      if (code === "QUOTA_EXCEEDED") {
        return new BangoError(
          `今月の利用上限に達しました${detail}。上限は月初にリセットされます。続けて使う場合は ${PRICING_URL} でプランを確認してください。`,
          status,
          code,
        );
      }
      return new BangoError(`短時間に呼び出しが集中しました。${wait}もう一度試してください。`, status, code);
    }
    default:
      return new BangoError(
        `Bango API でエラーが起きました（HTTP ${status}${p.code ? ` ${p.code}` : ""}）${detail}。時間をおいて再度試してください。`,
        status,
        code,
      );
  }
}

function formatDetails(details: unknown): string {
  if (!details) return "";
  try {
    return `詳細: ${JSON.stringify(details).slice(0, 400)}`;
  } catch {
    return "";
  }
}
