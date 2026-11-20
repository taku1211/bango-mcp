# リモート版（コネクタURL＋ログインで使う）

ローカル版（`npx bango-mcp` ＋ 環境変数 `BANGO_API_KEY`）に加えて、URL を追加して Bango API アカウントでログインするだけで使えるリモート MCP サーバーを提供する。ツール本体（`src/server.ts`）は両方で共通。

## 使う側の流れ

1. AI アシスタントの「コネクタを追加」に `https://mcp.bango-api.jp/mcp` を入れる
2. ブラウザで Bango API のログイン画面が開く（メール＋パスワード、または Google）
3. ログインすると、そのアカウントに「MCPコネクタ（クライアント名）」という APIキーが自動で発行され、接続完了

プラン・上限はアカウントのものがそのまま効く。接続を切るにはダッシュボードでそのキーを削除する（以降の呼び出しは「再接続してください」と案内する）。

## 構成

```
AIアシスタント ──(Streamable HTTP + Bearer)──▶ mcp.bango-api.jp/mcp ──(x-api-key)──▶ api.bango-api.jp/v1
       │                                            ▲
       └─ OAuth 2.1（DCR + PKCE）─▶ /authorize ─────┤ ログイン: Supabase Auth（bango-prod）
                                                     └ キー発行: POST /v1/onboarding/api-keys（ダッシュボードと同じ）
```

| 項目 | 内容 |
|---|---|
| 実装 | `src/remote/`（Hono + MCP SDK の WebStandard Streamable HTTP、ステートレス） |
| 認可 | MCP Authorization 仕様準拠。RFC 9728（Protected Resource Metadata）/ RFC 8414 / RFC 7591（動的クライアント登録）/ PKCE S256 必須 / RFC 8707 `resource` を検証 |
| 状態 | DB なし。client_id・認可コード・アクセス/リフレッシュトークンは `MCP_TOKEN_SECRET` で AES-256-GCM 暗号化した自己完結トークン。発行した APIキーはトークンの中にだけ持つ |
| トークン寿命 | アクセス 1時間、リフレッシュ 90日。認可コード 5分・1回限り（プロセス内で使用済み管理） |
| ログイン試行制限 | 同一IPから10分に10回まで（プロセス内） |
| 計測 | Bango API への User-Agent は `bango-mcp-remote/<version> (+https://github.com/taku1211/bango-mcp)`。ローカル版は `bango-mcp/<version> (...)` なので、Railway のログ（`@user_agent`）で分けて数えられる。キーのラベル「MCPコネクタ（…）」でも DB 上で区別できる |

## エンドポイント

| パス | 用途 |
|---|---|
| `POST /mcp` | MCP 本体（Bearer 必須。無い/無効なら 401 + `WWW-Authenticate: Bearer resource_metadata=...`） |
| `GET /.well-known/oauth-protected-resource[/mcp]` | 保護リソースのメタデータ |
| `GET /.well-known/oauth-authorization-server` | 認可サーバーのメタデータ |
| `POST /register` | 動的クライアント登録 |
| `GET /authorize` → `POST /authorize/password` | ログイン画面 → メール＋パスワードでログイン |
| `GET /authorize/google` → `/authorize/google/callback` | Google ログイン（Supabase の PKCE フロー） |
| `POST /token` | `authorization_code` / `refresh_token` |
| `GET /health` | ヘルスチェック |

## 環境変数

| 名前 | 必須 | 内容 |
|---|---|---|
| `MCP_PUBLIC_URL` | ✓ | 公開URL。例 `https://mcp.bango-api.jp` |
| `MCP_TOKEN_SECRET` | ✓ | 32文字以上のランダム文字列。変えると全トークンが無効になり、全員が再ログインになる |
| `SUPABASE_URL` | ✓ | bango-prod の Supabase URL（Web の `NEXT_PUBLIC_SUPABASE_URL` と同じ値） |
| `SUPABASE_ANON_KEY` | ✓ | 同 anon / publishable key（公開値） |
| `BANGO_API_BASE_URL` |  | 既定 `https://api.bango-api.jp/v1` |
| `MCP_GOOGLE_LOGIN` |  | `1` で Google ログインボタンを出す |
| `PORT` |  | Railway が自動で入れる |

## デプロイ手順（Railway）

1. 既存プロジェクト（bango-api-api-prod）にサービス `bango-mcp-remote` を追加済み（2026-11-20）。このリポジトリの main を接続。`railway.json` のとおり `npm ci`（自動）→ `npm run build` → `npm run start:remote`、ヘルスチェック `/health`
2. 上の環境変数を設定
3. カスタムドメイン `mcp.bango-api.jp` を割り当て、DNS に CNAME を追加
4. Google ログインを使う場合: Supabase の Auth → URL Configuration → Redirect URLs に `https://mcp.bango-api.jp/authorize/google/callback` を追加し、`MCP_GOOGLE_LOGIN=1`
5. 確認: `curl https://mcp.bango-api.jp/health`、claude.ai の「コネクタを追加」で URL を入れてログイン → ツール一覧が出ること
6. 公式 MCP Registry の `server.json` に `remotes`（`streamable-http`, `https://mcp.bango-api.jp/mcp`）を追加して再登録

## 既知の制約・今後

- 接続（ログイン）のたびに APIキーが1本増える。同じアプリで再接続した古いキーは自動では消さない（別端末の接続を壊さないため）。ダッシュボードで削除できる
- リフレッシュトークンはステートレスなので、ローテーション後も古いものが期限まで有効。強制的に切るにはキーを削除する
- 単一インスタンス前提（使用済み認可コード・ログイン試行回数をメモリで持つ）。複数台にするなら Redis 等へ移す
- Supabase のログイン API はこのサーバーの IP からまとめて呼ばれるので、利用者が増えたら Supabase 側のレート制限を確認する
- Client ID Metadata Document（URL を client_id にする方式）には未対応。現行の Claude・Cursor 等は動的クライアント登録で接続できる
