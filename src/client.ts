import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.bango-api.jp/v1";
export const SIGNUP_URL = "https://bango-api.jp/signup";
export const API_KEYS_URL = "https://bango-api.jp/dashboard/api-keys";
export const PRICING_URL = "https://bango-api.jp/pricing";

/** Bango API の応答エンベロープ（必要な部分だけ） */
export type Envelope<T> = {
  object: string;
  data: T;
  has_more?: boolean;
  meta?: {
    quota?: {
      api_requests?: { limit: number | null; remaining: number | null; unlimited: boolean } | null;
      batch_rows?: { limit: number | null; remaining: number | null; unlimited: boolean } | null;
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
};

export class BangoClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BangoClientOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<Envelope<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return this.request<T>(url, { method: "GET" });
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
          "user-agent": `bango-mcp/${VERSION} (+https://github.com/taku1211/bango-mcp)`,
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
      throw toBangoError(res.status, (json ?? {}) as Problem);
    }
    return json as Envelope<T>;
  }
}

function toBangoError(status: number, p: Problem): BangoError {
  const code = p.code ?? null;
  const detail = p.detail ? `（${p.detail}）` : "";
  switch (status) {
    case 401:
      return new BangoError(
        `APIキーが無効です${detail}。${API_KEYS_URL} でキーを確認し、BANGO_API_KEY を設定し直してください。`,
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
