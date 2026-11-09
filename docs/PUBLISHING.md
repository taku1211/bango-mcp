# 公開手順（オーナー作業）

npm と公式 MCP Registry への公開は、オーナーのアカウントで行います。

## 1. 動作確認（APIキーを使って実データで）

```bash
npm ci && npm run build
BANGO_API_KEY=xxxx npx @modelcontextprotocol/inspector node dist/index.js
```

Inspector で4つのツールを1回ずつ呼び、結果が返ることを確認します。

## 2. npm に公開

```bash
npm login            # npm の bango-mcp を持っているアカウント
npm publish          # prepublishOnly で typecheck・test・build が走る
```

公開後、`npx -y bango-mcp --version` が `0.1.0` を返せばOKです。

## 3. 公式 MCP Registry に登録

`package.json` の `mcpName` と `server.json` の `name`（`io.github.taku1211/bango-mcp`）が一致している必要があります（設定済み）。

```bash
# mcp-publisher を入れる（macOS）
brew install mcp-publisher
mcp-publisher login github     # taku1211 で認証
mcp-publisher publish          # server.json を登録
```

## 4. その他のディレクトリ

公式 Registry に載ると、多くのディレクトリ（PulseMCP など）が自動で取り込みます。手動で載せる場合は以下。

- Smithery: https://smithery.ai/new （GitHubリポジトリを指定）
- Glama: https://glama.ai/mcp/servers （リポジトリが公開なら自動で拾われることが多い）
- mcp.so: https://mcp.so/submit

## 5. バージョンを上げるとき

`src/version.ts`・`package.json`・`server.json`（2か所）の version をそろえて上げてから、2〜3 を繰り返します。
