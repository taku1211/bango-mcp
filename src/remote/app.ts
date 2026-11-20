import { createHash } from "node:crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { cors } from "hono/cors";

import { BangoClient, DEFAULT_BASE_URL } from "../client.js";
import { createServer } from "../server.js";
import { VERSION } from "../version.js";
import { type AccountGateway, LoginError } from "./account.js";
import { errorPage, landingPage, loginPage } from "./pages.js";
import { pkceS256, randomToken, safeEqual, TokenSealer } from "./token.js";

/**
 * API 側のログでローカル版（bango-mcp/x.y.z）と区別して数えるための User-Agent。
 * 毎朝の「mcp経由リクエスト数」はこの文字列の完全一致で集計する。
 */
export const REMOTE_USER_AGENT = `bango-mcp-remote/${VERSION} (+https://github.com/taku1211/bango-mcp)`;

export type RemoteAppOptions = {
  /** 公開URL（末尾スラッシュなし）。例: https://mcp.bango-api.jp */
  publicUrl: string;
  tokenSecret: string;
  account: AccountGateway;
  bangoApiBaseUrl?: string;
  googleLoginEnabled?: boolean;
  /** Bango API 呼び出し用（テストで差し替える） */
  fetchImpl?: typeof fetch;
  now?: () => number;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  batchWaitMs?: number;
  batchPollMs?: number;
};

type ClientPayload = { r: string[]; n: string };
type AuthRequestPayload = { cid: string; ru: string; cc: string; st?: string; n: string };
type CodePayload = { k: string; kid: string; cid: string; ru: string; cc: string; jti: string };
type GrantPayload = { k: string; kid: string; cid: string };
type GooglePayload = { req: string; v: string };

const SCOPE = "bango";
const CODE_TTL = 300;
const AUTH_REQUEST_TTL = 30 * 60;
const GOOGLE_COOKIE = "bango_mcp_google";

export function createRemoteApp(options: RemoteAppOptions): Hono {
  const base = options.publicUrl.replace(/\/+$/, "");
  const resource = `${base}/mcp`;
  const sealer = new TokenSealer(options.tokenSecret);
  const now = options.now ?? (() => Date.now());
  const accessTtl = options.accessTokenTtlSeconds ?? 60 * 60;
  const refreshTtl = options.refreshTokenTtlSeconds ?? 90 * 24 * 60 * 60;
  const usedCodes = new Map<string, number>();
  const loginLimiter = new FixedWindowLimiter(10, 10 * 60 * 1000);
  const secureCookie = base.startsWith("https://");

  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"],
      exposeHeaders: ["www-authenticate", "mcp-session-id", "mcp-protocol-version"],
      maxAge: 86400,
    }),
  );

  app.get("/", (c) => c.html(landingPage(resource)));
  app.get("/health", (c) => c.json({ ok: true, version: VERSION }));

  // --- メタデータ（RFC 9728 / RFC 8414） ------------------------------------
  const protectedResource = () => ({
    resource,
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Bango API（法人番号・インボイス）",
    resource_documentation: "https://github.com/taku1211/bango-mcp#readme",
  });
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResource()));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResource()));

  const authorizationServer = () => ({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: "https://github.com/taku1211/bango-mcp#readme",
  });
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServer()));
  app.get("/.well-known/oauth-authorization-server/mcp", (c) => c.json(authorizationServer()));

  // --- 動的クライアント登録（RFC 7591） -------------------------------------
  // DBを持たないので、登録内容（redirect_uris と表示名）を暗号化して client_id そのものにする。
  app.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
    if (!body || !Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.length > 10) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris は1〜10件の配列で指定してください。" }, 400);
    }
    const uris: string[] = [];
    for (const uri of body.redirect_uris) {
      if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
        return c.json({ error: "invalid_redirect_uri", error_description: `使用できない redirect_uri です: ${String(uri).slice(0, 200)}` }, 400);
      }
      uris.push(uri);
    }
    const name = sanitizeClientName(body.client_name);
    const clientId = sealer.seal<ClientPayload>("client", { r: uris, n: name });
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(now() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      },
      201,
    );
  });

  // --- 認可エンドポイント ---------------------------------------------------
  app.get("/authorize", (c) => {
    const q = c.req.query();
    const client = sealer.open<ClientPayload>("client", q.client_id);
    if (!client) return c.html(errorPage("接続元アプリの登録情報が無効です。アプリ側でコネクタを追加し直してください。"), 400);
    const redirectUri = q.redirect_uri ?? (client.r.length === 1 ? client.r[0] : undefined);
    if (!redirectUri || !redirectUriMatches(client.r, redirectUri)) {
      return c.html(errorPage("接続元アプリの戻り先（redirect_uri）が登録内容と一致しません。"), 400);
    }
    // ここから先のエラーは RFC 6749 §4.1.2.1 に従い戻り先へ返す
    if (q.response_type !== "code") return redirectError(c, redirectUri, q.state, "unsupported_response_type");
    if (!q.code_challenge || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) {
      return redirectError(c, redirectUri, q.state, "invalid_request", "PKCE（code_challenge_method=S256）が必要です。");
    }
    if (q.resource && stripSlash(q.resource) !== resource && stripSlash(q.resource) !== base) {
      return redirectError(c, redirectUri, q.state, "invalid_target");
    }
    const request = sealer.seal<AuthRequestPayload>(
      "authreq",
      { cid: hashClientId(q.client_id!), ru: redirectUri, cc: q.code_challenge, st: q.state, n: client.n },
      AUTH_REQUEST_TTL,
      now(),
    );
    return c.html(loginPage({ clientName: client.n, redirectHost: displayHost(redirectUri), request, googleEnabled: !!options.googleLoginEnabled }));
  });

  app.post("/authorize/password", async (c) => {
    const form = await c.req.parseBody();
    const requestToken = typeof form.request === "string" ? form.request : "";
    const req = sealer.open<AuthRequestPayload>("authreq", requestToken, now());
    if (!req) return c.html(errorPage("ログイン画面の有効期限が切れました。接続元アプリからもう一度やり直してください。"), 400);
    const email = typeof form.email === "string" ? form.email.trim() : "";
    const password = typeof form.password === "string" ? form.password : "";
    const rerender = (error: string, status: 400 | 401 | 429 | 503) =>
      c.html(
        loginPage({ clientName: req.n, redirectHost: displayHost(req.ru), request: requestToken, googleEnabled: !!options.googleLoginEnabled, error, email }),
        status,
      );
    if (!email || !password) return rerender("メールアドレスとパスワードを入力してください。", 400);
    if (!loginLimiter.take(clientIp(c), now())) {
      return rerender("ログインの試行回数が多すぎます。10分ほど待ってからもう一度お試しください。", 429);
    }
    try {
      const supabaseToken = await options.account.signInWithPassword(email, password);
      return await completeAuthorization(c, req, supabaseToken);
    } catch (error) {
      if (error instanceof LoginError) {
        const status = error.reason === "invalid_credentials" ? 401 : error.reason === "unavailable" ? 503 : 400;
        return rerender(error.message, status);
      }
      throw error;
    }
  });

  app.get("/authorize/google", (c) => {
    if (!options.googleLoginEnabled) return c.html(errorPage("Googleログインは現在使えません。"), 404);
    const requestToken = c.req.query("request") ?? "";
    if (!sealer.open<AuthRequestPayload>("authreq", requestToken, now())) {
      return c.html(errorPage("ログイン画面の有効期限が切れました。接続元アプリからもう一度やり直してください。"), 400);
    }
    const verifier = randomToken(48);
    setCookie(c, GOOGLE_COOKIE, sealer.seal<GooglePayload>("google", { req: requestToken, v: verifier }, 600, now()), {
      httpOnly: true,
      secure: secureCookie,
      sameSite: "Lax",
      path: "/authorize",
      maxAge: 600,
    });
    return c.redirect(options.account.googleAuthorizeUrl(`${base}/authorize/google/callback`, pkceS256(verifier)), 302);
  });

  app.get("/authorize/google/callback", async (c) => {
    const pending = sealer.open<GooglePayload>("google", getCookie(c, GOOGLE_COOKIE), now());
    deleteCookie(c, GOOGLE_COOKIE, { path: "/authorize" });
    const req = pending ? sealer.open<AuthRequestPayload>("authreq", pending.req, now()) : null;
    if (!pending || !req) return c.html(errorPage("ログインの有効期限が切れました。接続元アプリからもう一度やり直してください。"), 400);
    const code = c.req.query("code");
    if (!code) return c.html(errorPage("Googleログインがキャンセルされたか、失敗しました。"), 400);
    try {
      const supabaseToken = await options.account.exchangeGoogleCode(code, pending.v);
      return await completeAuthorization(c, req, supabaseToken);
    } catch (error) {
      if (error instanceof LoginError) return c.html(errorPage(error.message), error.reason === "unavailable" ? 503 : 400);
      throw error;
    }
  });

  async function completeAuthorization(c: Context, req: AuthRequestPayload, supabaseToken: string): Promise<Response> {
    const label = `MCPコネクタ（${req.n}）`.slice(0, 64);
    const issued = await options.account.issueApiKey(supabaseToken, label);
    const code = sealer.seal<CodePayload>(
      "code",
      { k: issued.apiKey, kid: issued.keyId, cid: req.cid, ru: req.ru, cc: req.cc, jti: randomToken(16) },
      CODE_TTL,
      now(),
    );
    const target = new URL(req.ru);
    target.searchParams.set("code", code);
    if (req.st) target.searchParams.set("state", req.st);
    target.searchParams.set("iss", base);
    return c.redirect(target.toString(), 302);
  }

  // --- トークンエンドポイント ------------------------------------------------
  app.post("/token", async (c) => {
    const params = await readParams(c);
    const tokenError = (error: string, description?: string, status: 400 | 401 = 400) =>
      c.json({ error, ...(description ? { error_description: description } : {}) }, status, { "cache-control": "no-store" });

    const clientId = params.client_id;
    if (!clientId || !sealer.open<ClientPayload>("client", clientId)) return tokenError("invalid_client", "client_id が無効です。", 401);
    const cid = hashClientId(clientId);

    let grant: GrantPayload;
    if (params.grant_type === "authorization_code") {
      const code = sealer.open<CodePayload>("code", params.code, now());
      if (!code || !safeEqual(code.cid, cid)) return tokenError("invalid_grant", "認可コードが無効か期限切れです。");
      if (params.redirect_uri && params.redirect_uri !== code.ru) return tokenError("invalid_grant", "redirect_uri が一致しません。");
      if (!params.code_verifier || !safeEqual(pkceS256(params.code_verifier), code.cc)) {
        return tokenError("invalid_grant", "code_verifier が一致しません。");
      }
      if (!consumeCode(code.jti, (code.exp ?? 0) * 1000)) return tokenError("invalid_grant", "認可コードは使用済みです。");
      grant = { k: code.k, kid: code.kid, cid };
    } else if (params.grant_type === "refresh_token") {
      const refresh = sealer.open<GrantPayload>("refresh", params.refresh_token, now());
      if (!refresh || !safeEqual(refresh.cid, cid)) return tokenError("invalid_grant", "リフレッシュトークンが無効か期限切れです。");
      grant = { k: refresh.k, kid: refresh.kid, cid };
    } else {
      return tokenError("unsupported_grant_type");
    }

    return c.json(
      {
        access_token: sealer.seal<GrantPayload>("access", grant, accessTtl, now()),
        token_type: "Bearer",
        expires_in: accessTtl,
        refresh_token: sealer.seal<GrantPayload>("refresh", grant, refreshTtl, now()),
        scope: SCOPE,
      },
      200,
      { "cache-control": "no-store", pragma: "no-cache" },
    );
  });

  function consumeCode(jti: string, expMs: number): boolean {
    const t = now();
    for (const [key, exp] of usedCodes) if (exp <= t) usedCodes.delete(key);
    if (usedCodes.has(jti)) return false;
    usedCodes.set(jti, expMs);
    return true;
  }

  // --- MCP エンドポイント（Streamable HTTP・ステートレス） --------------------
  const unauthorized = (c: Context, withError: boolean) => {
    const params = [`realm="bango"`, `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, `scope="${SCOPE}"`];
    if (withError) params.push(`error="invalid_token"`, `error_description="The access token is invalid or expired"`);
    c.header("www-authenticate", `Bearer ${params.join(", ")}`);
    return c.json({ error: withError ? "invalid_token" : "unauthorized" }, 401);
  };

  app.all("/mcp", async (c) => {
    const header = c.req.header("authorization");
    const bearer = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!bearer) return unauthorized(c, false);
    const grant = sealer.open<GrantPayload>("access", bearer, now());
    if (!grant) return unauthorized(c, true);

    // ステートレス運用なのでサーバーからの通知ストリーム（GET）とセッション削除（DELETE）は提供しない
    if (c.req.method !== "POST") {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405, { allow: "POST" });
    }

    const client = new BangoClient({
      apiKey: grant.k,
      baseUrl: options.bangoApiBaseUrl ?? DEFAULT_BASE_URL,
      fetchImpl: options.fetchImpl,
      userAgent: REMOTE_USER_AGENT,
      invalidKeyHint:
        "コネクタ用のAPIキーが削除されたか無効になっています。AIアシスタントの設定でBango APIコネクタを一度切断し、もう一度接続（ログイン）してください。",
    });
    const server = createServer({ client, batchWaitMs: options.batchWaitMs, batchPollMs: options.batchPollMs });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  return app;
}

// ---------------------------------------------------------------------------

function redirectError(c: Context, redirectUri: string, state: string | undefined, error: string, description?: string): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (description) url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return c.redirect(url.toString(), 302);
}

async function readParams(c: Context): Promise<Record<string, string | undefined>> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
  }
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"]);

export function isAllowedRedirectUri(uri: string): boolean {
  if (uri.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  // Cursor・VS Code などのデスクトップアプリはカスタムスキーム（cursor:// 等）で受け取る
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/** ループバックはポートが毎回変わるので、ポート以外が一致すればよい（RFC 8252 §7.3） */
export function redirectUriMatches(registered: string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;
  let cand: URL;
  try {
    cand = new URL(candidate);
  } catch {
    return false;
  }
  if (cand.protocol !== "http:" || !LOOPBACK_HOSTS.has(cand.hostname)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return reg.protocol === "http:" && reg.hostname === cand.hostname && reg.pathname === cand.pathname && reg.search === cand.search;
    } catch {
      return false;
    }
  });
}

function sanitizeClientName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return (name || "MCPクライアント").slice(0, 40);
}

function hashClientId(clientId: string): string {
  return createHash("sha256").update(clientId).digest("base64url");
}

function displayHost(uri: string): string {
  try {
    const url = new URL(uri);
    return url.host ? url.host : `${url.protocol}//`;
  } catch {
    return uri.slice(0, 80);
  }
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
}

class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  take(key: string, nowMs: number): boolean {
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= nowMs) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}
