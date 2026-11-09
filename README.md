# bango-mcp

[Bango API](https://bango-api.jp) の公式 MCP サーバーです。Claude・Cursor などの AI アシスタントに話しかけるだけで、日本の会社の**法人番号・所在地・インボイス（適格請求書発行事業者）の登録状況**を調べられます。

```
あなた：「サンプル商事って大阪の会社の法人番号わかる？」
AI    ：bango_find_company で候補を探し、所在地とインボイスの登録状況まで答えます

あなた：「この請求書の T1180301018771、去年の10月1日時点で有効だった？」
AI    ：bango_check_invoice でその日付時点の有効性を確認します

あなた：「この取引先リスト30社に法人番号を付けて」
AI    ：bango_match_companies でまとめて名寄せし、確実な一致と要確認を分けて返します
```

## できること（ツール）

| ツール | 使う場面 | 消費する枠 |
|---|---|---|
| `bango_find_company` | 会社名（表記ゆれOK）から法人を探す。都道府県・郵便番号で絞り込み可 | API 1回 |
| `bango_get_company` | 法人番号（13桁）か T番号から、正式名称・所在地・閉鎖の有無・インボイス登録状況を見る | API 1回 |
| `bango_check_invoice` | T番号が有効か確かめる。最大20件まとめて、日付指定（その日時点）も可 | 1件につき API 1回 |
| `bango_match_companies` | 会社名の一覧（最大50件）に法人番号をまとめて付ける（名寄せ） | 名寄せ 1件につき1行 |

- 「株式会社／㈱」「全角／半角」「ハイフン入りの番号」などは自動で吸収します。
- 候補が複数あるときは、AI が勝手に1社に決めずにあなたへ確認するよう設計しています。
- すべて読み取り専用です。データの変更や外部への送信は行いません。

## はじめかた

### 1. APIキーを取る（無料）

[bango-api.jp/signup](https://bango-api.jp/signup) で登録し、[ダッシュボード](https://bango-api.jp/dashboard/api-keys) で APIキーを発行します。新規登録すると30日間Proプラン無料トライアルが自動で始まり、通常APIは月500,000回、名寄せは月10,000件まで試せます。クレジットカードの登録は不要で、自動で課金されることはありません。終了後は Free プラン（月500回、名寄せ月50件）で続けて使えます（[料金](https://bango-api.jp/pricing)）。

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

不具合や要望は [Issues](https://github.com/taku1211/bango-mcp/issues) へ。お問い合わせ: support@bango-api.jp

---

## English

Official MCP server for [Bango API](https://bango-api.jp). It lets AI assistants identify Japanese companies by name (fuzzy matching) and look up corporate numbers (法人番号), addresses and qualified-invoice (T-number) registration status.

Tools: `bango_find_company`, `bango_get_company`, `bango_check_invoice`, `bango_match_companies` (all read-only).

```bash
claude mcp add bango -e BANGO_API_KEY=your_key -- npx -y bango-mcp
```

Get a free API key at https://bango-api.jp/signup (new sign-ups get a 30-day Pro trial, no credit card required). License: MIT.
