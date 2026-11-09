# json-gantt アーキテクチャ方針

作成: Fable（統括）。設計詳細は `docs/design/` に Opus が記述し、実装は Sonnet、レビューは Opus が担当する。
この文書は「変えないこと」を定める。詳細設計はこの範囲内で自由に決めてよい。

## 1. プロダクト要件（確定済み）

参考: gantt-online.com の操作動画（`~/Downloads/gantt.mp4`）。再現範囲は以下。

- 階層タスク（親はサマリーバー、期間・進捗は子から導出）
- FS（終了→開始）依存のみ。矢印表示 + **自動スケジューリング**（先行が動くと後続が後ろにずれる）
- バーのドラッグ移動 / 右端ドラッグで期間変更 / 親バーのドラッグで子を一括移動
- 進捗（0–100）、リソース（複数、ID参照）、色ラベル（ID参照）
- 左: ツリー表（行番号・名前・工数/期間）、中央: タイムライン（日/週/月ズーム）、右: 編集パネル、下: ステータスバー
- インデント/アウトデント、上下移動、追加、削除、Undo/Redo
- 対象外: 共有、スクリーンショット、Usage guide、作成者フィールド、リソース別ビュー

データ・ファイル:

- 1ウィンドウ = 1 JSON ファイル。新規フォーマットを JSON Schema (draft 2020-12) で定義し `schema/gantt.schema.json` に置く
- タスクはフラット配列 + `parentId`。`resources` / `colorLabels` はプロジェクト直下の一覧
- 日付は暦日ベース、ISO 8601 の **日付のみ** (`YYYY-MM-DD`)。`end` は **包含**（1日タスクは start == end）
- 稼働日設定はオプション（週末の曜日、祝日リスト）。設定があれば期間計算・自動スケジューリングは稼働日で数える。設定がなければ全日稼働
- 保存は明示（Cmd/Ctrl+S・保存ボタン）。未保存はウィンドウタイトルに印
- 書き戻し時: 未知フィールド保持、キー順はスキーマ定義順、インデント 2、末尾改行
- 外部変更はファイル監視で検知して通知し、再読込か上書きかを確認
- スキーマ違反のファイルはエラー一覧を表示して開かない
- 引数 / ドラッグ&ドロップで開く。最近開いたファイル一覧

PDF:

- 表 + タイムラインを一体で出力。A3 横。全体を 1 ページに縮小、幅が収まらなければ横方向に分割
- 日本語フォント埋め込み必須（Noto Sans JP をアプリに同梱）
- 画面の折りたたみ状態・ズームを反映

プラットフォーム: macOS 優先、Windows 動作保証。UI は日本語、文言は i18n ファイルに分離。

## 2. 技術スタック

| 層 | 選定 |
|---|---|
| シェル | Tauri 2 |
| フロント | React 18 + TypeScript + Vite、パッケージマネージャは pnpm |
| 描画 | SVG を自前描画（ライブラリ不使用）。表とタイムラインは同じ座標系で描き、PDF 用に 1 枚の SVG に合成できる構造にする |
| 状態 | Zustand + immer。Undo/Redo は immer の patches で実装 |
| バリデーション | Rust 側 `jsonschema` クレート（読み込み時）。フロント側は型（スキーマから生成）で担保 |
| ファイル I/O・監視 | Rust 側。`serde_json` + `notify` |
| AI アシスタント | ユーザーのマシンの Claude Code CLI（`claude -p`）を Rust 側が固定引数で起動・停止し、一時ディレクトリを管理する。検証・差分・取り込みはフロント（`docs/design/06-ai-pane.md`） |
| PDF | フロントが画面と同じ SVG 文字列を生成し、Rust 側で `usvg` + `svg2pdf` によりフォント埋め込み付き PDF に変換。ページ分割は viewBox を横にスライス |
| 設定保存 | `tauri-plugin-store`（最近開いたファイル、ウィンドウ状態） |
| テスト | スケジューリング/階層エンジンは vitest、Rust 側は cargo test |

## 3. 責務の分割

```
src-tauri/            Rust: ファイル I/O、スキーマ検証、未知フィールド保持、監視、PDF 変換、最近開いたファイル、claude プロセスの起動・停止
  src/document.rs       serde モデル（flatten で未知フィールド保持、構造体の順序 = キー順）
  src/schema.rs         jsonschema で検証、エラーを path 付きで返す
  src/commands/*.rs     open/save/validate/export_pdf/recent_files
  src/watcher.rs        notify によるファイル監視 → イベント発火
  src/pdf.rs            SVG→PDF（Noto Sans JP 埋め込み、横分割）
schema/gantt.schema.json   唯一の正。TS 型は json-schema-to-typescript で生成
src/
  model/                生成型 + ID/日付ユーティリティ
  engine/               純粋関数のみ（UI 非依存、テスト対象）
    calendar.ts           稼働日計算（加算・差分・次の稼働日）
    hierarchy.ts          親子の導出（期間、進捗、工数）、インデント/アウトデント、並べ替え
    scheduling.ts         FS 依存の自動スケジューリング、循環検出
    commands.ts           ユーザー操作を状態変更に変換（move/resize/indent/...）
  store/                Zustand ストア、Undo/Redo、dirty 管理
  components/           Toolbar / TaskGrid / Timeline / SidePanel / StatusBar / dialogs
  export/               画面状態から PDF 用 SVG を合成
  i18n/                 ja.json と t()
  tauri/                invoke ラッパ、イベント購読
```

原則:

- **engine は副作用なし**。入力はドキュメント + 操作、出力は新しいドキュメント（または patches）。ここにロジックを集め、コンポーネントは薄く保つ
- **導出値（親の期間・進捗・工数）は JSON に保存しない**。読み込み時に計算する。JSON の正はリーフタスクの値
- **ID は UUID v4**。順序は配列順（`order` フィールドは持たない）
- 自動スケジューリングは「後続を遅らせる方向」のみ自動。先行が前に動いても後続は自動では前に詰めない（ユーザーの手動配置を壊さないため）。循環依存は作成を拒否する
- スキーマの変更は `schema/gantt.schema.json` → 型生成 → Rust モデル の順で必ず 3 か所同期する。`version` フィールドをトップレベルに持つ

## 4. 開発の進め方

1. Opus: `docs/design/` に詳細設計（スキーマ、エンジン仕様、UI 仕様、バックエンド仕様、作業パッケージ分割）
2. Fable: 設計レビューと確定
3. Sonnet: 作業パッケージ単位で実装（各パッケージは単独でビルド・テストが通ること）
4. Opus: パッケージごとにレビュー、Fable が差し戻し判断
5. Fable: 結合、実機確認（`pnpm tauri dev`）、PDF 出力確認
