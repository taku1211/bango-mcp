import { createHash, randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import { AccountGateway } from "../src/remote/account.js";
import { createRemoteApp, isAllowedRedirectUri, REMOTE_USER_AGENT, redirectUriMatches } from "../src/remote/app.js";
import { TokenSealer } from "../src/remote/token.js";

const BASE = "https://mcp.example.test";
const SECRET = "x".repeat(40);
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

type Call = { url: string; init: RequestInit };

function setup(opts: { onboarded?: boolean; onboardingCompletes?: boolean; password?: string; apiStatus?: number; googleLoginEnabled?: boolean; now?: () => number } = {}) {
  const accountCalls: Call[] = [];
  let onboarded = opts.onboarded !== false;
  const apiCalls: Call[] = [];
  const accountFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    accountCalls.push({ url, init });
    if (url.includes("/auth/v1/token?grant_type=password")) {
      const body = JSON.parse(String(init.body));
      if (body.password !== (opts.password ?? "correct")) {
        return Response.json({ error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 });
      }
      return Response.json({ access_token: "sb-access", token_type: "bearer" });
    }
    if (url.includes("/auth/v1/token?grant_type=pkce")) {
      return Response.json({ access_token: "sb-google", token_type: "bearer" });
    }
    if (url.endsWith("/v1/onboarding/complete")) {
      if (opts.onboardingCompletes === false) return Response.json({ code: "DEPENDENCY_UNAVAILABLE" }, { status: 503 });
      onboarded = true;
      return Response.json({ onboarding_completed: true });
    }
    if (url.endsWith("/v1/onboarding/api-keys")) {
      if (!onboarded) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
      return Response.json({ api_key: { id: "key-1", issued: true, plaintext: "bango_live_issued", key_prefix: "bango_live", label: "x", created_at: "2026-11-20T00:00:00Z" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const apiFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    apiCalls.push({ url, init });
    if (opts.apiStatus && opts.apiStatus !== 200) return Response.json({ status: opts.apiStatus, code: "UNAUTHORIZED" }, { status: opts.apiStatus });
    return Response.json({
      object: "list",
      data: [{ corporate_number: "1180301018771", name: "トヨタ自動車株式会社", name_kana: null, prefecture_code: "23", city_code: null, score: 1 }],
      has_more: false,
    });
  }) as typeof fetch;
  const app = createRemoteApp({
    publicUrl: BASE,
    tokenSecret: SECRET,
    bangoApiBaseUrl: "https://api.example.test/v1",
    googleLoginEnabled: opts.googleLoginEnabled,
    fetchImpl: apiFetch,
    now: opts.now,
    account: new AccountGateway({
      supabaseUrl: "https://auth.example.test",
      supabaseAnonKey: "anon",
      bangoApiBaseUrl: "https://api.example.test/v1",
      fetchImpl: accountFetch,
    }),
  });
  return { app, accountCalls, apiCalls };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(app: ReturnType<typeof setup>["app"], redirectUris: unknown = [REDIRECT], name: unknown = "Claude") {
  return app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: name }),
  });
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-123",
    resource: `${BASE}/mcp`,
    ...extra,
  });
  return `/authorize?${q}`;
}

function hiddenRequest(html: string): string {
  const m = html.match(/name="request" value="([^"]+)"/);
  if (!m) throw new Error("request field not found");
  return m[1]!.replace(/&amp;/g, "&");
}

async function login(app: ReturnType<typeof setup>["app"], request: string, password = "correct", ip = "1.1.1.1") {
  return app.request("/authorize/password", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body: new URLSearchParams({ request, email: "user@example.com", password }).toString(),
  });
}

async function fullFlow(ctx: ReturnType<typeof setup>) {
  const { app } = ctx;
  const reg = (await (await register(app)).json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const page = await app.request(authorizeUrl(reg.client_id, challenge));
  const res = await login(app, hiddenRequest(await page.text()));
  const location = new URL(res.headers.get("location")!);
  const code = location.searchParams.get("code")!;
  const token = await app.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT }).toString(),
  });
  return { clientId: reg.client_id, verifier, code, location, tokenRes: token, tokens: (await token.clone().json()) as Record<string, string> };
}

async function mcpClient(app: ReturnType<typeof setup>["app"], accessToken: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: ((input: string | URL | Request, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("redirect uri rules", () => {
  it("allows https, loopback http and app schemes; rejects others", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:5000/cb")).toBe(true);
    expect(isAllowedRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("https://a.example/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });
  it("matches loopback with a different port only", () => {
    expect(redirectUriMatches(["http://127.0.0.1:1000/cb"], "http://127.0.0.1:2000/cb")).toBe(true);
    expect(redirectUriMatches(["http://127.0.0.1:1000/cb"], "http://127.0.0.1:2000/other")).toBe(false);
    expect(redirectUriMatches(["https://a.example/cb"], "https://a.example/cb2")).toBe(false);
  });
});

describe("token sealer", () => {
  it("rejects tampering, wrong type and expiry", () => {
    const s = new TokenSealer(SECRET);
    const t = s.seal("access", { k: "key" }, 60, 1_000_000);
    expect(s.open("access", t, 1_000_000)?.k).toBe("key");
    expect(s.open("refresh", t, 1_000_000)).toBeNull();
    expect(s.open("access", t, 1_000_000 + 61_000)).toBeNull();
    expect(s.open("access", `${t.slice(0, -2)}AA`, 1_000_000)).toBeNull();
    expect(new TokenSealer("y".repeat(40)).open("access", t, 1_000_000)).toBeNull();
    expect(() => new TokenSealer("short")).toThrow();
  });
});

describe("metadata", () => {
  it("publishes protected resource and authorization server metadata", async () => {
    const { app } = setup();
    const prm = (await (await app.request("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${BASE}/mcp`);
    expect(prm.authorization_servers).toEqual([BASE]);
    const as = (await (await app.request("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(BASE);
    expect(as.registration_endpoint).toBe(`${BASE}/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});

describe("dynamic client registration", () => {
  it("registers a public client", async () => {
    const { app } = setup();
    const res = await register(app);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.client_id).toBe("string");
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_name).toBe("Claude");
  });
  it("rejects missing or unsafe redirect uris", async () => {
    const { app } = setup();
    expect((await register(app, [])).status).toBe(400);
    expect((await register(app, "https://x")).status).toBe(400);
    expect((await register(app, ["http://evil.example.com/cb"])).status).toBe(400);
    const bad = await app.request("/register", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
  });
});

describe("authorize", () => {
  it("shows a login page naming the client and redirect host", async () => {
    const { app } = setup();
    const reg = (await (await register(app, [REDIRECT], "<b>Claude</b>")).json()) as { client_id: string };
    const res = await app.request(authorizeUrl(reg.client_id, pkce().challenge));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&lt;b&gt;Claude&lt;/b&gt;");
    expect(html).toContain("claude.ai");
    expect(html).not.toContain("Googleでログイン");
    expect(html).toContain("メールアドレスで無料登録");
    expect(html).not.toContain("30日");
  });
  it("rejects an unknown client or a redirect uri that was not registered", async () => {
    const { app } = setup();
    expect((await app.request(authorizeUrl("bogus", pkce().challenge))).status).toBe(400);
    const reg = (await (await register(app)).json()) as { client_id: string };
    const res = await app.request(authorizeUrl(reg.client_id, pkce().challenge, { redirect_uri: "https://evil.example/cb" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
  it("redirects back with an error when PKCE is missing or the resource is foreign", async () => {
    const { app } = setup();
    const reg = (await (await register(app)).json()) as { client_id: string };
    const noPkce = await app.request(authorizeUrl(reg.client_id, pkce().challenge, { code_challenge_method: "plain" }));
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const foreign = await app.request(authorizeUrl(reg.client_id, pkce().challenge, { resource: "https://other.example/mcp" }));
    expect(new URL(foreign.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    const badType = await app.request(authorizeUrl(reg.client_id, pkce().challenge, { response_type: "token" }));
    const loc = new URL(badType.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("unsupported_response_type");
    expect(loc.searchParams.get("state")).toBe("st-123");
  });
});

describe("password login", () => {
  it("issues an API key labelled for the client and redirects with code and state", async () => {
    const ctx = setup();
    const { location, tokenRes, tokens } = await fullFlow(ctx);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("st-123");
    expect(location.searchParams.get("iss")).toBe(BASE);
    const issue = ctx.accountCalls.find((c) => c.url.endsWith("/v1/onboarding/api-keys"))!;
    expect((issue.init.headers as Record<string, string>).authorization).toBe("Bearer sb-access");
    expect(JSON.parse(String(issue.init.body))).toEqual({ label: "MCPコネクタ（Claude）" });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).not.toContain("bango_live_issued");
  });
  it("re-renders the form on wrong password without issuing a key", async () => {
    const ctx = setup();
    const reg = (await (await register(ctx.app)).json()) as { client_id: string };
    const page = await ctx.app.request(authorizeUrl(reg.client_id, pkce().challenge));
    const res = await login(ctx.app, hiddenRequest(await page.text()), "wrong");
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("メールアドレスかパスワードが違います");
    expect(ctx.accountCalls.some((c) => c.url.endsWith("/onboarding/api-keys"))).toBe(false);
  });
  it("finishes signup on the spot for an account that never opened the dashboard", async () => {
    const ctx = setup({ onboarded: false });
    const { tokenRes } = await fullFlow(ctx);
    expect(tokenRes.status).toBe(200);
    const complete = ctx.accountCalls.find((c) => c.url.endsWith("/v1/onboarding/complete"))!;
    expect((complete.init.headers as Record<string, string>).authorization).toBe("Bearer sb-access");
  });
  it("explains when the account has not finished signup", async () => {
    const ctx = setup({ onboarded: false, onboardingCompletes: false });
    const reg = (await (await register(ctx.app)).json()) as { client_id: string };
    const page = await ctx.app.request(authorizeUrl(reg.client_id, pkce().challenge));
    const res = await login(ctx.app, hiddenRequest(await page.text()));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("初期登録がまだ完了していません");
  });
  it("rejects an expired or forged login request", async () => {
    const { app } = setup();
    const res = await login(app, "b1.forged");
    expect(res.status).toBe(400);
  });
  it("rate limits repeated attempts from one IP", async () => {
    const ctx = setup();
    const reg = (await (await register(ctx.app)).json()) as { client_id: string };
    const req = hiddenRequest(await (await ctx.app.request(authorizeUrl(reg.client_id, pkce().challenge))).text());
    for (let i = 0; i < 10; i++) expect((await login(ctx.app, req, "wrong", "9.9.9.9")).status).toBe(401);
    expect((await login(ctx.app, req, "wrong", "9.9.9.9")).status).toBe(429);
    expect((await login(ctx.app, req, "wrong", "8.8.8.8")).status).toBe(401);
  });
});

describe("google login", () => {
  it("round-trips through Supabase PKCE and issues a code", async () => {
    const ctx = setup({ googleLoginEnabled: true });
    const reg = (await (await register(ctx.app)).json()) as { client_id: string };
    const html = await (await ctx.app.request(authorizeUrl(reg.client_id, pkce().challenge))).text();
    expect(html).toContain("Googleでログイン");
    const start = await ctx.app.request(`/authorize/google?request=${encodeURIComponent(hiddenRequest(html))}`);
    expect(start.status).toBe(302);
    const supa = new URL(start.headers.get("location")!);
    expect(supa.origin + supa.pathname).toBe("https://auth.example.test/auth/v1/authorize");
    expect(supa.searchParams.get("redirect_to")).toBe(`${BASE}/authorize/google/callback`);
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const back = await ctx.app.request("/authorize/google/callback?code=abc", { headers: { cookie } });
    expect(back.status).toBe(302);
    expect(new URL(back.headers.get("location")!).searchParams.get("code")).toBeTruthy();
    const exchange = ctx.accountCalls.find((c) => c.url.includes("grant_type=pkce"))!;
    expect(JSON.parse(String(exchange.init.body)).auth_code).toBe("abc");
  });
  it("fails without the pending cookie and is hidden when disabled", async () => {
    const enabled = setup({ googleLoginEnabled: true });
    expect((await enabled.app.request("/authorize/google/callback?code=abc")).status).toBe(400);
    const disabled = setup();
    expect((await disabled.app.request("/authorize/google?request=x")).status).toBe(404);
  });
});

describe("token endpoint", () => {
  it("rejects a wrong verifier, a reused code and another client", async () => {
    const ctx = setup();
    const flow = await fullFlow(ctx);
    const post = (params: Record<string, string>) =>
      ctx.app.request("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
      });
    const reuse = await post({ grant_type: "authorization_code", code: flow.code, code_verifier: flow.verifier, client_id: flow.clientId });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe("invalid_grant");

    const other = (await (await register(ctx.app)).json()) as { client_id: string };
    const refreshOther = await post({ grant_type: "refresh_token", refresh_token: flow.tokens.refresh_token!, client_id: other.client_id });
    expect(refreshOther.status).toBe(400);

    expect((await post({ grant_type: "password", client_id: flow.clientId })).status).toBe(400);
    expect((await post({ grant_type: "authorization_code", code: "x", client_id: "bogus" })).status).toBe(401);
  });
  it("rejects a wrong PKCE verifier", async () => {
    const ctx = setup();
    const reg = (await (await register(ctx.app)).json()) as { client_id: string };
    const page = await ctx.app.request(authorizeUrl(reg.client_id, pkce().challenge));
    const res = await login(ctx.app, hiddenRequest(await page.text()));
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const token = await ctx.app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: reg.client_id }),
    });
    expect(token.status).toBe(400);
  });
  it("refreshes tokens", async () => {
    const ctx = setup();
    const flow = await fullFlow(ctx);
    const res = await ctx.app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: flow.tokens.refresh_token!, client_id: flow.clientId }).toString(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
  });
  it("expires the access token after its TTL", async () => {
    let t = 1_800_000_000_000;
    const ctx = setup({ now: () => t });
    const flow = await fullFlow(ctx);
    t += 3601 * 1000;
    const res = await ctx.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${flow.tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("mcp endpoint", () => {
  it("challenges unauthenticated requests with resource metadata", async () => {
    const { app } = setup();
    const res = await app.request("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect(res.headers.get("www-authenticate")).not.toContain("invalid_token");
    const forged = await app.request("/mcp", { method: "POST", body: "{}", headers: { authorization: "Bearer b1.nope" } });
    expect(forged.status).toBe(401);
    expect(forged.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
  it("lists tools and calls the API with the issued key and the remote User-Agent", async () => {
    const ctx = setup();
    const { tokens } = await fullFlow(ctx);
    const client = await mcpClient(ctx.app, tokens.access_token!);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["bango_check_invoice", "bango_count_companies", "bango_export_companies_csv", "bango_find_company", "bango_get_company", "bango_list_companies", "bango_match_companies"]);
    const result = await client.callTool({ name: "bango_find_company", arguments: { company_name: "トヨタ自動車" } });
    expect(result.isError).toBeFalsy();
    const call = ctx.apiCalls.at(-1)!;
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("bango_live_issued");
    expect(headers["user-agent"]).toBe(REMOTE_USER_AGENT);
    expect(REMOTE_USER_AGENT.startsWith("bango-mcp-remote/")).toBe(true);
    await client.close();
  });
  it("tells the user to reconnect when the connector key was deleted", async () => {
    const ctx = setup({ apiStatus: 401 });
    const { tokens } = await fullFlow(ctx);
    const client = await mcpClient(ctx.app, tokens.access_token!);
    const result = await client.callTool({ name: "bango_find_company", arguments: { company_name: "トヨタ自動車" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("もう一度接続");
    await client.close();
  });
  it("does not offer a GET stream in stateless mode", async () => {
    const ctx = setup();
    const { tokens } = await fullFlow(ctx);
    const res = await ctx.app.request("/mcp", { method: "GET", headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(res.status).toBe(405);
  });
});
