# ツール設計メモ（v0.1.0）

## 参考にしたベストプラクティス

- Anthropic「Writing effective tools for agents — with agents」（2025-09-11）
  https://www.anthropic.com/engineering/writing-tools-for-agents
- MCP 仕様 2026-07-28「Tools」
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools

## このサーバーでの適用

| 原則 | bango-mcp での実装 |
|---|---|
| APIエンドポイントを1対1で包まない。よくある仕事の単位でツールを作る | APIは30以上あるが、ツールは「探す／詳しく見る／T番号を確かめる／まとめて名寄せ」の4つだけ。名寄せは投入→完了待ち→結果取得を1ツールにまとめた |
| ツールの目的が重ならないようにする | 名前だけ分かる→find、番号が分かる→get、請求書のT番号→check、一覧→match。説明文に「どの場面で使うか」「次にどのツールを呼ぶか」を書いた |
| 名前空間をそろえる | すべて `bango_` で始める（他のMCPサーバーと並んでも区別できる） |
| 意味のある情報を返す。内部IDより人が読める値 | 都道府県コードは「大阪府」に、インボイスは「有効／失効／登録取消／未登録」に変換。必要な時だけ `response_format: detailed` で全項目 |
| 入力の名前を明確にし、ゆるく受け取る | `company_name`・`number`・`registration_numbers`。ハイフン・全角数字・「大阪」「27」「osaka」・「2024/10/1」などは内部で正規化 |
| トークンを節約する | 検索は既定5件、T番号は最大20件、名寄せは最大50件。結果は要点のみ |
| エラーは原因と次の行動を文章で | 401→キーの設定場所、429→待つか上限か、404→番号確認か find を使う、形式不正→正しい例。APIキー未設定でも起動し、取得方法を案内 |
| 曖昧なときに推測させない | 候補が複数なら「ユーザーに確認して」と hint と instructions で明示 |
| 仕様のフィールドを正しく使う | `title`、`annotations`（readOnlyHint=true ほか）、`structuredContent` と同じJSONをテキストでも返す、実行エラーは `isError: true` |

## 今後の候補

- 公式URL・業種の補完（別プロジェクトで検証中。API本体に入り次第ツールに追加）
- 変更監視（watch-targets）のツール化。書き込みを伴うので確認フローを設計してから
- リモートMCP（Streamable HTTP）版。claude.ai のコネクタから直接使えるようにする
- 実ユーザーの質問を集めた評価セットでの説明文チューニング
