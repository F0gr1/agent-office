---
name: agent-office
description: このAgentOfficeプロジェクトの依頼をOfficeの指揮官と登録エージェントへ渡し、専用アプリで進捗・担当別成果・最終結果を確認する。既定の受付運用に使う。停止・状況照会・連携修理は直接扱い、Office内部の担当から再転送しない。
---

# Codexを受付、Agent Officeを実行役にする

対象はこのSkillを含むAgent Officeプロジェクト。ユーザーが別の進め方を指定しない限り、依頼・質問をOfficeへ渡す。グローバル設定や他プロジェクトの依頼は自動変更しない。

`AGENT_OFFICE_WORKER=1` の場合はこの転送手順を実行しない。Office内の担当は割り当てを直接処理する。

## 依頼を渡す

ユーザーの入力、求める成果、変更してよい範囲、今回必要な会話の文脈を整理する。未指定の要件や外部操作の許可を追加しない。単純な質問も指揮官に渡せる。担当を定型的に呼ぶ指示や `specialists` の固定指定はしない。

実行内容を短く伝え、指示をUTF-8の一時ファイルへ安全に保存する。シェルの引数へ生の依頼文を埋め込まない。ファイルは0600など自分だけが読める権限を使う。以下の `OFFICE_ROOT` には実際のAgent Office cloneの絶対パスを指定する。

```sh
OFFICE_ROOT=/absolute/path/to/AgentOffice
node "$OFFICE_ROOT/scripts/office.mjs" \
  --workspace "$OFFICE_ROOT" \
  --instruction-file /absolute/request.txt
```

Macアプリがあれば起動し、未起動ならサーバーを準備する。送信後は該当の依頼IDを専用アプリで開く。アプリがなければブラウザーを使う。`--no-open` は画面を開かない実行に限って使う。

送信は1回だけ。エラーや応答断のときは、既に受け付けられた可能性を確認してから判断する。実行中の別依頼がある場合は、勝手に停止・重複送信しない。

## 追跡して結果を返す

返されたIDを保持し、次の入口で確認する。

```sh
node "$OFFICE_ROOT/scripts/office.mjs" --state
node "$OFFICE_ROOT/scripts/office.mjs" --status RUN_ID
node "$OFFICE_ROOT/scripts/office.mjs" --show RUN_ID
```

`--state` はOffice全体の実行状況と最近のID、`--status` は指定した依頼の詳細を取得し、どちらも画面を再表示しない。「今どうなっているか」だけの質問にはこの読取操作で回答し、新しい依頼を作らない。実行中は必要な間隔で追跡し、ユーザーが状況を把握できるよう短く更新する。待ち時間のために新しいAI実行や新しいチャットを作らない。

`completed`、`needs_attention`、`failed`、`cancelled` を区別する。担当結果は `tasks`、編成と選定理由は `dispatch` にある。指揮官の最終回答、検証結果、未確認・残課題を読み、ユーザーへ取りまとめる。受付成功や一担当の工程終了を依頼全体の完了にしない。追加の実地検証が必要なら許可範囲で確認し、確認できないことは明記する。

元の依頼の修正・続きなら、今回の追加内容だけを新しいファイルに保存し、該当のIDを指定する。

```sh
node "$OFFICE_ROOT/scripts/office.mjs" \
  --continue RUN_ID --instruction-file /absolute/followup.txt
```

継続は元の要件・成果を引き継ぐ新しい実行。実行中の処理へ直接割り込む方式ではない。別の話題を無関係な履歴へつなげない。

これはCodexから明示的に渡した依頼の実行であり、Codex内部の既存サブエージェントや未取得の会話本文の同期ではない。非公開の推論を表示するとは説明しない。公開・コミット・外部通知などの追加操作は、この連携の利用を理由に許可されたと扱わない。
