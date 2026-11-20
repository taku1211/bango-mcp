// ログイン画面とエラー画面。外部依存を持たない素のHTMLにする（CSP で script を禁止できるように JS なし）。

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#14171c;--muted:#5b6370;--line:#d9dde3;--accent:#1f5eff;--accent-text:#fff;--error-bg:#fdecec;--error:#a32020}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--text:#eef0f3;--muted:#a3abb7;--line:#2c313a;--accent:#5b8cff;--accent-text:#0b0d11;--error-bg:#3a1717;--error:#ffb4b4}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.6}
main{max-width:420px;margin:48px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px 24px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px}.muted{color:var(--muted);font-size:14px}
label{display:block;font-size:14px;font-weight:600;margin:12px 0 4px}
input[type=email],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--text);font-size:16px}
button,.button{display:block;width:100%;margin-top:16px;padding:11px 12px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-text);font-size:15px;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}
.button.secondary{background:transparent;color:var(--text);border-color:var(--line)}
.or{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px;margin:20px 0 0}.or:before,.or:after{content:"";flex:1;border-top:1px solid var(--line)}
.error{background:var(--error-bg);color:var(--error);border-radius:8px;padding:10px 12px;font-size:14px;margin:0 0 12px}
.client{border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:14px;margin:0 0 16px;word-break:break-all}
footer{margin-top:16px;font-size:13px;color:var(--muted);text-align:center}footer a{color:inherit}
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}<footer><a href="https://bango-api.jp" rel="noopener">Bango API</a> · <a href="https://bango-api.jp/terms" rel="noopener">利用規約</a> · <a href="https://bango-api.jp/privacy" rel="noopener">プライバシー</a></footer></main></body></html>`;
}

export function loginPage(input: {
  clientName: string;
  redirectHost: string;
  request: string;
  googleEnabled: boolean;
  error?: string;
  email?: string;
}): string {
  const error = input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : "";
  const google = input.googleEnabled
    ? `<div class="or">または</div><a class="button secondary" href="/authorize/google?request=${encodeURIComponent(input.request)}">Googleでログイン</a>`
    : "";
  return layout(
    "Bango API にログイン",
    `<div class="card">
<h1>Bango API にログイン</h1>
<p class="muted">ログインすると、次のアプリから Bango API の法人番号・インボイス検索を使えるようになります。</p>
<div class="client"><strong>${escapeHtml(input.clientName)}</strong><br><span class="muted">接続先: ${escapeHtml(input.redirectHost)}</span></div>
${error}
<form method="post" action="/authorize/password">
<input type="hidden" name="request" value="${escapeHtml(input.request)}">
<label for="email">メールアドレス</label>
<input id="email" name="email" type="email" autocomplete="email" required value="${escapeHtml(input.email ?? "")}">
<label for="password">パスワード</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">ログインして接続する</button>
</form>
<p class="muted" style="margin:8px 0 0;text-align:right"><a href="https://bango-api.jp/forgot-password" rel="noopener">パスワードを忘れた方</a></p>
${google}
<p class="muted" style="margin-top:20px">接続すると、このアカウントに「MCPコネクタ」用のAPIキーが自動で発行されます。利用回数はご契約プランの上限に数えられます。接続を解除するには、<a href="https://bango-api.jp/dashboard/api-keys" rel="noopener">ダッシュボード</a>でそのキーを削除してください。</p>
<p class="muted">アカウントをお持ちでない方は <a href="https://bango-api.jp/signup" rel="noopener">無料登録</a>（30日間Proトライアル付き）</p>
</div>`,
  );
}

export function errorPage(message: string): string {
  return layout(
    "接続できませんでした",
    `<div class="card"><h1>接続できませんでした</h1><p class="error" role="alert">${escapeHtml(message)}</p><p class="muted">接続元のアプリに戻って、もう一度お試しください。</p></div>`,
  );
}

export function landingPage(mcpUrl: string): string {
  return layout(
    "Bango API MCP サーバー",
    `<div class="card"><h1>Bango API MCP サーバー</h1>
<p>Claude などの AI アシスタントから、日本の会社の法人番号・所在地・インボイス登録状況を調べられるリモート MCP サーバーです。</p>
<p class="muted">コネクタの URL</p>
<div class="client"><code>${escapeHtml(mcpUrl)}</code></div>
<p class="muted">AI アシスタントの「コネクタを追加」にこの URL を入れ、Bango API アカウントでログインするだけで使えます。APIキーの設定は不要です。</p>
<a class="button secondary" href="https://github.com/taku1211/bango-mcp#readme" rel="noopener">使い方を見る</a></div>`,
  );
}
