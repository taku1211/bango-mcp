# bango-mcp

[Bango API](https://bango-api.jp) の公式 MCP サーバーです。Claude・Cursor などの AI アシスタントに話しかけるだけで、日本の会社の**法人番号・所在地・インボイス（適格請求書発行事業者）の登録状況**を調べたり、**エリアと業種で会社のリスト（公式サイトURL・業種つき、CSVも可）**を作ったりできます。

```
あなた：「サンプル商事って大阪の会社の法人番号わかる？」
AI    ：bango_find_company で候補を探し、所在地とインボイスの登録状況まで答えます

あなた：「この請求書の T1180301018771、去年の10月1日時点で有効だった？」
AI    ：bango_check_invoice でその日付時点の有効性を確認します

あなた：「この取引先リスト30社に法人番号を付けて」
AI    ：bango_match_companies でまとめて名寄せし、確実な一致と要確認を分けて返します

あなた：「大阪市の工務店で、公式サイトがある会社をリストにしてCSVで」
AI    ：bango_list_companies で大阪市×建設×サイトありを取り、出典つきの表とCSVを返します
```

## できること（ツール）

| ツール | 使う場面 | 消費する枠 |
|---|---|---|
| `bango_find_company` | 会社名（表記ゆれOK）から法人を探す。都道府県・郵便番号で絞り込み可 | API 1回 |
| `bango_get_company` | 法人番号（13桁）か T番号から、正式名称・所在地・閉鎖の有無・インボイス登録状況を見る | API 1回 |
| `bango_check_invoice` | T番号が有効か確かめる。最大20件まとめて、日付指定（その日時点）も可 | 1件につき API 1回 |
| `bango_match_companies` | 会社名の一覧（最大50件）に法人番号をまとめて付ける（名寄せ） | 名寄せ 1件につき1行 |
| `bango_list_companies` | 都道府県・市区町村（政令市は名前で全区）・郵便番号と業種で会社のリストを作る。公式サイトの有無で絞り込み可、CSVでも返せる | 返した社数（エリア・業種リストの月間社数枠） |

- 「株式会社／㈱」「全角／半角」「ハイフン入りの番号」などは自動で吸収します。
- 候補が複数あるときは、AI が勝手に1社に決めずにあなたへ確認するよう設計しています。
- すべて読み取り専用です。データの変更や外部への送信は行いません。
- `bango_list_companies` の月間社数枠は Free 100社、Starter 500社、Growth 3,000社、Pro 10,000社です。電話番号・問い合わせフォームは、Free では有無だけ、Starter 以上では番号とURLまで返します。
- 公式サイトURLと業種には出典（公的名簿・Common Crawl など）と観測日が付きます。出典を表示すれば、納品・組み込みを含む商用利用ができます。

## はじめかた

### いちばん簡単：コネクタURLを追加してログインするだけ（APIキー不要）

claude.ai・Claude Desktop・Claude Code・ChatGPT・Cursor など、リモート MCP（カスタムコネクタ）に対応したアプリなら、次の URL を追加して Bango API アカウントでログインするだけで使えます。Node.js も APIキーの設定も要りません。

```
https://mcp.bango-api.jp/mcp
```

- **claude.ai / Claude Desktop**: 設定 → コネクタ → 「カスタムコネクタを追加」で、名前に `Bango MCP`、URL に上の URL を入れる → ログイン画面でメール＋パスワードか Google でログイン
- **Claude Code**: `claude mcp add --transport http bango-mcp https://mcp.bango-api.jp/mcp` → `/mcp` から認証
- **ChatGPT**: カスタムMCPサーバーを追加できるプラン（Business・Enterprise/Edu など）で、「＋」→「カスタムMCPサーバーを追加」から上の URL を入れ、認証は OAuth
- **Cursor**: `~/.cursor/mcp.json` に `{"mcpServers": {"bango": {"url": "https://mcp.bango-api.jp/mcp"}}}` を追加してログイン
- アカウントがない場合は [bango-api.jp/signup](https://bango-api.jp/signup) で無料登録してから接続してください
- 詳しい手順と頼み方の例は [bango-api.jp/mcp](https://bango-api.jp/mcp) にまとめています
- 接続すると、ダッシュボードに「MCPコネクタ（アプリ名）」という APIキーが自動で作られます。利用回数はご契約プランの上限に数えられ、そのキーを削除すると接続が切れます

以下は、手元で `npx` から動かすローカル版の手順です。

### 1. APIキーを取る（無料）

[bango-api.jp/signup](https://bango-api.jp/signup) で登録し、[ダッシュボード](https://bango-api.jp/dashboard/api-keys) で APIキーを発行します。Free プラン（月500回、名寄せ月50件、エリア・業種リスト月100社）はクレジットカードの登録なしで使えます（[料金](https://bango-api.jp/pricing)）。

### 2. AI アシスタントに登録する

Node.js 20 以上が必要です。

**Claude Code**

```bash
claude mcp add bango -e BANGO_API_KEY=あなたのAPIキー -- npx -y bango-mcp
```

**Claude Desktop**（設定 → 開発者 → 設定を編集 で `claude_desktop_config.json` を開く）

```json
{
  "mcpServers": {
    "bango": {
      "command": "npx",
      "args": ["-y", "bango-mcp"],
      "env": { "BANGO_API_KEY": "あなたのAPIキー" }
    }
  }
}
```

**Cursor**（`~/.cursor/mcp.json` またはプロジェクトの `.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "bango": {
      "command": "npx",
      "args": ["-y", "bango-mcp"],
      "env": { "BANGO_API_KEY": "あなたのAPIキー" }
    }
  }
}
```

VS Code・Windsurf など他の MCP クライアントも、同じ `npx -y bango-mcp` と環境変数 `BANGO_API_KEY` で動きます。

### 3. 話しかける

- 「トヨタ自動車の法人番号と本社所在地を教えて」
- 「T1180301018771 は今も有効？」
- 「この5社がインボイス登録しているか一覧にして：…」
- 「スプレッドシートの取引先名に法人番号を付けたい。要確認のものは候補も出して」

## 設定

| 環境変数 | 必須 | 説明 |
|---|---|---|
| `BANGO_API_KEY` | ○ | Bango API の APIキー |
| `BANGO_API_BASE_URL` | | 接続先の上書き（既定 `https://api.bango-api.jp/v1`） |

## データの出典

国税庁法人番号システム Web-API 機能および国税庁適格請求書発行事業者公表システム Web-API 機能を利用して取得した情報をもとに、Bango API が編集・加工して提供しています。内容は国税庁によって保証されたものではありません。

## 開発

```bash
npm install
npm test          # ユニットテスト（実際のAPIは呼びません）
npm run build     # dist/ に出力
BANGO_API_KEY=... npx @modelcontextprotocol/inspector node dist/index.js   # 手元で動作確認
```

リモート版（コネクタURL＋ログインで使う版）の構成と運用は [docs/REMOTE.md](docs/REMOTE.md) を参照してください。

不具合や要望は [Issues](https://github.com/taku1211/bango-mcp/issues) へ。お問い合わせ: support@bango-api.jp

リリースやデータ更新のお知らせは公式X [@bangoapi](https://x.com/bangoapi) で発信しています。

---

## English

Official MCP server for [Bango API](https://bango-api.jp). It lets AI assistants identify Japanese companies by name (fuzzy matching) look up corporate numbers (法人番号), addresses and qualified-invoice (T-number) registration status, and build company lists by area and industry with official website URLs and sources (CSV available).

Tools: `bango_find_company`, `bango_get_company`, `bango_check_invoice`, `bango_match_companies`, `bango_list_companies` (all read-only).

Easiest: add a custom connector named `Bango MCP` with the URL `https://mcp.bango-api.jp/mcp` in claude.ai, Claude Desktop, Claude Code, ChatGPT or Cursor and sign in with your Bango API account (no API key setup needed). Or run it locally:

```bash
claude mcp add bango -e BANGO_API_KEY=your_key -- npx -y bango-mcp
```

Get a free API key at https://bango-api.jp/signup (the Free plan needs no credit card). Updates: [@bangoapi on X](https://x.com/bangoapi). License: MIT.
