// Bango API アカウント（Supabase Auth）でログインし、そのアカウントに MCP コネクタ用の
// APIキーを発行する。キー発行はダッシュボードと同じ /v1/onboarding/api-keys を使うので、
// プラン・上限・トライアル・失効（ダッシュボードでの削除）は既存の仕組みがそのまま効く。

export type AccountGatewayOptions = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  bangoApiBaseUrl: string;
  fetchImpl?: typeof fetch;
};

export type IssuedKey = { apiKey: string; keyId: string };

export class LoginError extends Error {
  constructor(
    message: string,
    readonly reason: "invalid_credentials" | "email_not_confirmed" | "not_onboarded" | "unavailable",
  ) {
    super(message);
    this.name = "LoginError";
  }
}

const SIGNUP_URL = "https://bango-api.jp/signup";

export class AccountGateway {
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AccountGatewayOptions) {
    this.supabaseUrl = options.supabaseUrl.replace(/\/+$/, "");
    this.anonKey = options.supabaseAnonKey;
    this.apiBase = options.bangoApiBaseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async signInWithPassword(email: string, password: string): Promise<string> {
    const res = await this.supabase("/auth/v1/token?grant_type=password", { email, password });
    return this.accessTokenFrom(res);
  }

  googleAuthorizeUrl(redirectTo: string, codeChallenge: string): string {
    const url = new URL(`${this.supabaseUrl}/auth/v1/authorize`);
    url.searchParams.set("provider", "google");
    url.searchParams.set("redirect_to", redirectTo);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "s256");
    return url.toString();
  }

  async exchangeGoogleCode(authCode: string, codeVerifier: string): Promise<string> {
    const res = await this.supabase("/auth/v1/token?grant_type=pkce", { auth_code: authCode, code_verifier: codeVerifier });
    return this.accessTokenFrom(res);
  }

  async issueApiKey(supabaseAccessToken: string, label: string): Promise<IssuedKey> {
    const first = await this.requestApiKey(supabaseAccessToken, label);
    if (first !== "not_onboarded") return first;
    // Google で初めて来た人や、メール確認のあと Web を開かずに来た人は初期登録がまだ。
    // Web の登録直後と同じ処理をここで済ませ、コネクタの画面だけで登録から接続まで終わらせる。
    await this.completeOnboarding(supabaseAccessToken);
    const second = await this.requestApiKey(supabaseAccessToken, label);
    if (second === "not_onboarded") {
      throw new LoginError(
        `このアカウントは Bango API の初期登録がまだ完了していません。${SIGNUP_URL} から登録を完了してから、もう一度接続してください。`,
        "not_onboarded",
      );
    }
    return second;
  }

  private async completeOnboarding(supabaseAccessToken: string): Promise<void> {
    try {
      await this.fetchImpl(`${this.apiBase}/onboarding/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${supabaseAccessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // 失敗したらキー発行の再試行が not_onboarded を返し、案内文に落ちる。
    }
  }

  private async requestApiKey(supabaseAccessToken: string, label: string): Promise<IssuedKey | "not_onboarded"> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}/onboarding/api-keys`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${supabaseAccessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ label }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new LoginError("Bango API に接続できませんでした。少し待ってからもう一度お試しください。", "unavailable");
    }
    if (res.status === 404) return "not_onboarded";
    if (!res.ok) {
      throw new LoginError(`APIキーを発行できませんでした（HTTP ${res.status}）。時間をおいてもう一度お試しください。`, "unavailable");
    }
    const json = (await res.json().catch(() => null)) as { api_key?: { id?: string; plaintext?: string } } | null;
    const apiKey = json?.api_key?.plaintext;
    const keyId = json?.api_key?.id;
    if (!apiKey || !keyId) {
      throw new LoginError("APIキーを発行できませんでした。時間をおいてもう一度お試しください。", "unavailable");
    }
    return { apiKey, keyId };
  }

  private async supabase(path: string, body: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(this.supabaseUrl + path, {
        method: "POST",
        headers: { apikey: this.anonKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new LoginError("ログインサービスに接続できませんでした。少し待ってからもう一度お試しください。", "unavailable");
    }
  }

  private async accessTokenFrom(res: Response): Promise<string> {
    const json = (await res.json().catch(() => null)) as
      | { access_token?: string; error_code?: string; error?: string; msg?: string }
      | null;
    if (res.ok && json?.access_token) return json.access_token;
    const code = json?.error_code ?? json?.error ?? "";
    if (code === "email_not_confirmed") {
      throw new LoginError("メールアドレスの確認が済んでいません。登録時に届いたメールのリンクを開いてから、もう一度お試しください。", "email_not_confirmed");
    }
    if (res.status === 400 || res.status === 401 || res.status === 422) {
      throw new LoginError("メールアドレスかパスワードが違います。", "invalid_credentials");
    }
    throw new LoginError("ログインできませんでした。時間をおいてもう一度お試しください。", "unavailable");
  }
}
