# 05. 作業パッケージ（Sonnet 実装用）

各パッケージは**単独でビルド・テストが通る**粒度。前のパッケージがマージ済みであることを前提に、記載の順で実装する。設計文書と食い違う実装判断が必要になった場合は、実装せずに質問として報告する（設計側で文書を直してから進める）。

## 共通ルール

- 設計文書の参照表記: `01§4.2` = `docs/design/01-data-model.md` の §4.2。`ARCH` = `docs/ARCHITECTURE.md`。
- 全パッケージ共通の受け入れ基準（以下を毎回満たすこと。各パッケージの表では省略する）:

| コマンド | 期待結果 |
|---|---|
| `pnpm install --frozen-lockfile` | 成功（依存を追加した場合は lockfile を更新してコミット） |
| `pnpm typecheck` | エラー 0 |
| `pnpm test` | 全テスト成功（skip / only を残さない） |
| `pnpm build` | 成功 |
| `cargo test --manifest-path src-tauri/Cargo.toml`（WP5 以降） | 全テスト成功 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`（WP5 以降） | 警告 0 |

- エンジン（`src/engine/`）は `react` / `zustand` / `@tauri-apps/*` / `Date.now()` / `Math.random()` / `crypto` を import・使用しない（`grep -rE "from \"(react|zustand|@tauri-apps)" src/engine` が 0 件）。
- UI 文言は `src/i18n/ja.json` 経由（`src/components` 内に日本語リテラルが無い: `grep -rP "[\p{Han}\p{Hiragana}\p{Katakana}]" src/components` が 0 件。コメントは除外してよいが、できればコメントも英語）。
- 生成ファイル `src/model/schema.d.ts` は手で編集しない。
- 開発環境: Rust ツールチェーン（stable、`rustup`）が必要。**要確認**: 設計時点のこのマシンでは `cargo` が PATH に無かった。WP5 着手前に `rustup` の導入を確認すること。

## 依存関係

```
WP0 ─┬─ WP1 ─ WP2 ─ WP3 ─ WP4 ─ WP6 ─ WP7 ─ WP8 ─┐
     │     └──────────────────── WP5 ───────────┼─ WP9 ─ WP10
     └──────────────────────────────────────────┘
```

| WP | 前提 | 並行可能 |
|---|---|---|
| WP1 | WP0 | — |
| WP2 | WP1 | WP5 |
| WP3 | WP2 | WP5 |
| WP4 | WP3 | WP5 |
| WP5 | WP1 | WP2〜WP4, WP6〜WP8 |
| WP6 | WP4 | WP5 |
| WP7 | WP6 | WP5 |
| WP8 | WP7 | WP5 |
| WP9 | WP6, WP5 | WP7, WP8（ただし `src/components/chart/*` の変更が競合しないよう WP7 の後を推奨） |
| WP10 | WP5, WP8, WP9 | — |
| WP11a | WP10 | WP11b |
| WP11b | WP10 | WP11a |
| WP11c | WP11a, WP11b | — |

WP11（AI 会話ペイン、06-ai-pane）は WP10 までの完成後に追加する機能。`WP10 ─┬─ WP11a ─┬─ WP11c` / `└─ WP11b ─┘`。

---

## WP0 スキャフォールド（別エージェントが着手中）

- 目的: Tauri 2 + React 18 + TS + Vite + pnpm の雛形、ARCH §3 のディレクトリ構成。
- 受け入れ: `pnpm tauri dev` でウィンドウが開く。`pnpm build` 成功。
- 本設計からの申し送り（WP5 で対応）: Cargo.toml の `usvg 0.48` / `pdf-writer 0.15` は svg2pdf 0.13 と不整合（04§4.1, 04§8）。`tauri-plugin-fs` と npm の `@tauri-apps/plugin-fs`・`@tauri-apps/plugin-store` は不要（04§8, 04§10）。

---

## WP1 スキーマ・型生成・モデルユーティリティ

- 目的: スキーマを唯一の正として TS 型を生成し、日付・ID ユーティリティを用意する。
- 参照: 01 全体（特に §2, §7）、`schema/gantt.schema.json`、`schema/examples/sample.json`（設計時に作成済み。内容は変更しない）
- 作成/変更:
  - `src/model/schema.d.ts`（`pnpm gen:types` の生成物）
  - `src/model/types.ts`、`src/model/date.ts`、`src/model/id.ts`
  - `src/model/__tests__/date.test.ts`、`src/model/__tests__/schema.test.ts`
  - `package.json`: devDependencies に `ajv`（^8）・`ajv-formats`（^3）を追加（テスト専用）。scripts に `"check:types": "pnpm gen:types && git diff --exit-code src/model/schema.d.ts"`
- 受け入れ基準:

| コマンド | 期待結果 |
|---|---|
| `pnpm gen:types && git diff --exit-code src/model/schema.d.ts` | 差分なし（コミット済みの生成物と一致） |
| `pnpm vitest run src/model` | 成功。最低限: `toEpochDay("1970-01-01") === 0`、`addDays("2023-05-31", 1) === "2023-06-01"`、`addDays("2024-02-28", 1) === "2024-02-29"`、`diffDays("2023-05-22","2023-06-02") === 11`、`dayOfWeek("2023-05-22") === 1`、`isValidIsoDate("2023-02-30") === false`、`TZ=America/Los_Angeles pnpm vitest run src/model` でも同じ結果 |
| schema.test.ts | Ajv2020 + ajv-formats で sample.json が valid。`version: 2`、`progress: 101`、`start: "2023-13-01"`、`tasks` 欠損、`tasks[0].custom = 1`（未知フィールド）の 5 ケースで、最後だけ valid |

---

## WP2 エンジン: calendar + hierarchy

- 目的: 稼働日計算と木構造・導出値・構造変更（依存の検査を除く）。
- 参照: 02§1, 02§2, 02§6, 02§7.1, 02§7.2（H1〜H8）
- 作成: `src/engine/calendar.ts`、`src/engine/hierarchy.ts`、`src/engine/errors.ts`、`src/engine/__tests__/fixtures.ts`、`calendar.test.ts`、`hierarchy.test.ts`
- 注: 構造変更関数（indent/outdent/moveUp/moveDown/deleteTasks）は immer の draft を受けて変更する関数として実装する（02§2.4）。テストでは `produce` で包んで呼ぶ。indent の I6/I7 検査は WP3 で `validateStructure` を作ってから組み込むため、本 WP では検査フックを引数（`(draft) => boolean`、既定は常に true）で受ける形にしておく。
- 受け入れ基準:

| コマンド | 期待結果 |
|---|---|
| `pnpm vitest run src/engine/__tests__/calendar.test.ts` | C1〜C10 すべて成功（テスト名に ID を含める: `it("C4: addWorkingDays ...")`） |
| `pnpm vitest run src/engine/__tests__/hierarchy.test.ts` | H1〜H8 すべて成功 |

---

## WP3 エンジン: scheduling + commands + document

- 目的: FS 自動スケジューリング、循環検出、全コマンド、読み込み正規化・保存前処理。
- 参照: 02§3, 02§4, 02§5, 02§7.2（H9〜H12）, 02§7.3〜§7.5、01§3, 01§4, 01§5.2
- 作成: `src/engine/scheduling.ts`、`src/engine/commands.ts`、`src/engine/document.ts`、`src/engine/index.ts`、`scheduling.test.ts`、`commands.test.ts`、`document.test.ts`（hierarchy.test.ts に H9〜H12 を追加）
- 受け入れ基準:

| コマンド | 期待結果 |
|---|---|
| `pnpm vitest run src/engine` | C*, H1〜H12, S1〜S17, K1〜K18, L1〜L7 がすべて成功 |
| `pnpm vitest run src/engine --coverage`（`@vitest/coverage-v8` を devDependency に追加） | `src/engine/**` の行カバレッジ 90% 以上 |
| K16 を全コマンド種別で実行するパラメタライズドテスト | 各コマンドの inversePatches 適用結果が元のドキュメントと `toEqual` |
| 性能テスト（`scheduling.test.ts` 内） | 1000 タスク・999 依存の直列チェーンの先頭を `moveTask(+1)` して 200ms 未満 |

---

## WP4 ストアと Undo/Redo

- 目的: Zustand + immer のストア、Undo/Redo（patches）、dirty 管理、プレビュー、view 操作。
- 参照: 03§15, 02§4.4, 02§4.5
- 作成: `src/store/appStore.ts`、`src/store/selectors.ts`、`src/store/__tests__/appStore.test.ts`
- 受け入れ基準（`pnpm vitest run src/store`）:

| # | 操作 | 期待 |
|---|---|---|
| U1 | sample を load → `dispatch(moveTask)` → `undo()` | doc が load 直後と `toEqual`、isDirty false |
| U2 | U1 の後 `redo()` | moveTask 後と一致、isDirty true |
| U3 | dispatch 2 回 → save（`markSaved`）→ undo | isDirty true、redo で false |
| U4 | patches が空のコマンド（`moveTask(B, -2)`、S8 の状態） | undo スタックが増えない、isDirty 不変 |
| U5 | `setZoom("week")` | isDirty true、undo スタック不変、undo しても zoom は week のまま |
| U6 | `setPreview(x)` → `clearPreview()` | doc 不変、undo スタック不変 |
| U7 | 201 回 dispatch | undo スタック長 200 |
| U8 | `addTask` dispatch | `selectedId` が新 id、`editing = { field: "name" }` |
| U9 | 親を折りたたみ → その親の下に `indent` で入れる | 親が展開される（reveal）、viewDirty true |
| U10 | エラーになるコマンド | `dispatch` が `{ ok:false }` を返し、doc・スタック不変 |

---

## WP5 Rust バックエンド（PDF 以外）

- 目的: serde モデル、スキーマ検証、移行、原子的保存、監視、最近開いたファイル、ウィンドウ管理、メニュー、イベント。
- 参照: 04§1〜§3, 04§5〜§10、01§4.1, 01§5, 01§6
- 作成/変更: `src-tauri/Cargo.toml`（04§8 のとおり。PDF 系クレートは WP9 まで未使用でも依存に入れてよい）、`src-tauri/src/{lib.rs,error.rs,document.rs,schema.rs,migrate.rs,fileio.rs,watcher.rs,menu.rs,state.rs}`、`src-tauri/src/commands/{mod.rs,file.rs,recent.rs,watch.rs,window.rs}`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json`、`src-tauri/tests/fixtures/*.json`、`package.json`（不要プラグイン削除）
- `export_pdf` は WP9 で実装（本 WP では登録しない）。
- 受け入れ基準:

| コマンド | 期待結果 |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml` | 04§3.1 の 7 テスト、04§3.3 のスキーマテスト 5 件、加えて: `open_file` 相当の内部関数で BOM 付きファイルが読める / 壊れた JSON で `PARSE_ERROR` の line・column が正しい / `version: 2` で `UNSUPPORTED_VERSION` / `AppError` の JSON 化で `kind` が `"IO"` 等になる / watcher: 一時ディレクトリでファイルを書き換えると 1 秒以内にハンドラが `modified` を 1 回呼ぶ、自分の save では呼ばない（ハンドラをクロージャ注入してテスト） |
| `pnpm tauri dev` | 起動しメニュー（ファイル/編集）が日本語で表示される |
| `grep -n "usvg\s*=" src-tauri/Cargo.toml` | 0 件 |

---

## WP6 UI: 読み取り専用のチャート描画

- 目的: レイアウト計算と Grid / Timeline の SVG 描画、スクロール、ズーム切替、折りたたみ、選択、i18n 基盤。
- 参照: 03§1〜§5, 03§8.3, 03§16
- 作成: `src/i18n/ja.json`（03§16 の全キー）、`src/i18n/index.ts`（`t`）、`src/components/chart/{constants.ts,layout.ts,ChartView.tsx,GridHeader.tsx,GridBody.tsx,TimelineHeader.tsx,TimelineBody.tsx,Bars.tsx,Arrows.tsx}`、`src/components/chart/__tests__/layout.test.ts`、`src/App.tsx`（仮: 開発時はサンプルを表示）
- 開発用の表示: Tauri 連携前なので、`import.meta.env.DEV` かつドキュメント未ロードのとき `schema/examples/sample.json` を Vite の JSON import で `loadDocument` して表示する（WP10 で削除）。
- 受け入れ基準:

| コマンド / 確認 | 期待結果 |
|---|---|
| `pnpm vitest run src/components/chart` | sample + day ズームで: range.start = `2023-05-15`、dayWidth 68、rows 31、行 0 の y = 0、行 5 の y = 130、`2023-05-22` の x = 476、Define goals のバー x = 476 / w = 68、A Project Plan は summary で x = 476、w = 12×68 = 816。week ズームで headerBottom のセル幅 140。矢印 "Define goals（行 index 2、中心 y=65）→ Kickoff meeting（行 index 4、上端 104、中心 117）" の d が `M 544 65 H 552 V 104 H 536 V 117 H 544`（x2 - x1 = 0 < 16 のため迂回）。head が `544,117 538,113.5 538,120.5` |
| 同テスト | 折りたたみ: Initiation を collapsed にすると rows 26、Initiation の子を端点に持つ矢印は Initiation 行に置き換わる |
| `pnpm dev`（ブラウザ） | サンプルが表示され、縦スクロールで表とタイムラインが同期、横スクロールで表が固定、ヘッダが上に固定。日/週/月の切替ができる（レビュアーがスクリーンショットで確認） |

> 行 index は表示順 0 始まり（0: A Project Plan, 1: Initiation, 2: Define goals, 3: Identify stakeholders, 4: Kickoff meeting）。

---

## WP7 UI: 編集操作

- 目的: ドラッグ（移動・リサイズ・リンク）、インライン編集、ツールバー、キーボードショートカット、トースト。
- 参照: 03§6, 03§7, 03§8, 03§11.4, 03§11.6
- 作成: `src/components/chart/dragMachine.ts`（状態遷移を純粋関数 `reduce(state, event) → { state, effect }` として実装）、`src/components/chart/useDrag.ts`、`src/components/chart/InlineEditor.tsx`、`src/components/Toolbar.tsx`、`src/components/icons.tsx`、`src/components/keymap.ts`（`(KeyboardEvent 相当, context) → Action | null` の純粋関数）、`src/components/useKeyboard.ts`、`src/components/Toast.tsx`、`src/components/dialogs/ConfirmDialog.tsx`、テスト `dragMachine.test.ts`・`keymap.test.ts`
- 受け入れ基準:

| コマンド / 確認 | 期待結果 |
|---|---|
| `pnpm vitest run src/components` | dragMachine: pointerdown→move(2px)→up でコマンド無し / move(70px, day) で `moveTask delta 1` のプレビュー / up で dispatch 1 回 / Escape で dispatch 0 回。keymap: mac で `metaKey+z` は null（メニュー担当）、`Enter` は編集中 null・非編集中 `addTask`、`Tab` は `indent`、`Alt+ArrowUp` は `moveUp`、Windows で `ctrlKey+y` は `redo` |
| `pnpm dev` 手動確認 | バーのドラッグで後続が押し出される様子がプレビューされ、離すと確定、Cmd+Z（ブラウザでは Ctrl/Cmd+Z を keymap の開発用フォールバックで処理）で 1 回で戻る。Enter で追加→名前編集→Enter で確定→Enter でさらに追加 |

> ブラウザ（`pnpm dev`）にはネイティブメニューが無いため、`keymap.ts` は `isTauri()` が false のときだけ Mod+Z / Mod+Shift+Z / Mod+S 等も処理する（開発用フォールバック）。

---

## WP8 UI: 右パネル・ステータスバー・ダイアログ

- 目的: SidePanel（Project / Tasks タブ）、StatusBar、SchemaErrorDialog、ExternalChangeDialog、UnsavedCloseDialog、警告バナー、EmptyState。
- 参照: 03§9, 03§10, 03§11, 03§13
- 作成: `src/components/SidePanel/{SidePanel.tsx,TasksTab.tsx,ProjectTab.tsx,PredecessorEditor.tsx}`、`src/components/StatusBar.tsx`、`src/components/dialogs/{SchemaErrorDialog.tsx,ExternalChangeDialog.tsx,UnsavedCloseDialog.tsx,WarningsBanner.tsx}`、`src/components/EmptyState.tsx`、`src/components/statusText.ts`（ステータスバー文字列の純粋関数）とテスト
- ダイアログは props で内容・コールバックを受ける表示専用コンポーネントとし、Tauri 連携（いつ出すか）は WP10。
- 受け入れ基準:

| コマンド / 確認 | 期待結果 |
|---|---|
| `pnpm vitest run src/components` | statusText(sample): `タスク: 31`、`工数: 214h`（sample の全リーフ hours 合計）、`期間: 2w`、進捗は 02§2.3 の計算値を `toFixed(2)` |
| `pnpm dev` 手動確認 | 進捗スライダーを動かして離すと Undo 1 回で戻る。親にリソースを付けると子全員に付く。先行タスクを追加すると後続が押し出される。循環する追加はトーストで拒否 |

---

## WP9 PDF 出力

- 目的: 画面と同じ部品で 1 枚の SVG を合成し、Rust で A3 横 PDF（Noto Sans JP 埋め込み・横分割）に変換。
- 参照: 03§12, 04§4
- 作成: `src/export/composeSvg.tsx`、`src/export/__tests__/composeSvg.test.ts`、`src-tauri/src/pdf.rs`、`src-tauri/src/commands/pdf.rs`（`export_pdf` を登録）、`src-tauri/resources/fonts/{NotoSansJP-Regular.otf,NotoSansJP-Bold.otf,OFL.txt}`（notofonts/noto-cjk の `Sans/SubsetOTF/JP/` にある静的サブセット OTF。統括側が取得済みで、スクラッチパッドからコピーする）、Toolbar の PDF ボタン配線
- 受け入れ基準:

| コマンド / 確認 | 期待結果 |
|---|---|
| `pnpm vitest run src/export` | sample（day ズーム）の SVG: ルートの `width` = 330 + timelineWidth、`height` = 40 + 48 + 31×26 = 894、`font-family="Noto Sans JP"`、`rgba(` を含まない、today 線・選択枠を含まない、`<image` を含まない |
| `cargo test --manifest-path src-tauri/Cargo.toml pdf` | 04§4.4 の 3 テスト成功 |
| `pnpm tauri dev` 手動確認 | sample を day ズームで出力 → 1 ページ（A3 横）、日本語が表示され、PDF ビューアでテキスト選択可能。60 日以上のタスクを追加して day ズームで出力 → 複数ページ、各ページ左に表が繰り返される。折りたたみ・ズームが反映される |

---

## WP10 結合: 開く・保存・最近・監視・D&D・メニュー

- 目的: フロントと Rust の結合。ファイルのライフサイクル全体。
- 参照: 03§11, 03§13, 03§14, 04§2, 04§5, 04§6, 04§7, 04§9
- 作成/変更: `src/tauri/{api.ts,types.ts,events.ts}`、`src/app/fileActions.ts`（open/new/save/saveAs/reload/close の手順）、`src/App.tsx`（開発用サンプル表示を削除、menu-action・open-file-requested・file-changed-externally の購読、`take_pending_open`、`onCloseRequested`、`onDragDropEvent`、ウィンドウタイトル）
- 受け入れ基準:

| コマンド / 確認 | 期待結果 |
|---|---|
| `pnpm vitest run src/app` | fileActions を Tauri API のモックで検証: 保存成功で `markSaved`、`SCHEMA_INVALID` で SchemaErrorDialog 用の状態がセットされる、外部変更（未保存なし）で「再読み込み」を選ぶと doc が置換され Undo 履歴が空 |
| 手動チェックリスト（`pnpm tauri dev`、macOS と Windows） | (1) 空状態から sample.json を開く → 表示・最近開いたファイルに追加 (2) 編集するとタイトルに ● (3) Cmd/Ctrl+S で保存しタイトルの ● が消える、`git diff schema/examples/sample.json` が編集箇所のみ (4) 未編集で保存すると元ファイルとバイト一致 (5) 外部エディタで変更 → 通知ダイアログ (6) 自分の保存では通知されない (7) スキーマ違反のファイルを開く → エラー一覧、開かない (8) Finder/エクスプローラーから D&D で開く (9) 2 つ目のファイルを開くと新しいウィンドウ (10) 未保存で閉じると確認 (11) `pnpm tauri build` 後、ファイルを引数に起動して開ける (12) 最近開いたファイルから削除済みファイルが消える |

---

## WP11a AI ペイン: エンジン・ストア・パーサ

- 目的: AI 編集の取り込み（`replaceDocument`、Undo 1 単位）と、stream-json の解釈・変更要約・プロンプト組み立て・会話ストア・送信手順を、UI と Rust 抜きで完成させる（Tauri API はモックで検証）。
- 参照: 06§2, 06§3, 06§4.1〜§4.7, 06§7.1、02§4.5
- 作成/変更:
  - `src/engine/equal.ts`（`deepEqual`）、`src/engine/commands.ts`（`replaceDocument` 追加）、`src/engine/index.ts`
  - `src/ai/{parseStream.ts,transcript.ts,summarizeChanges.ts,prompt.ts,aiStore.ts,aiActions.ts}`
  - `src/tauri/{api.ts,events.ts,types.ts}`（`aiLocate` / `aiRun` / `aiStop` / `aiReset` / `aiSetClaudePath`、`onAiEvent`、`AiRunResult` 等の型、`AppError` に `AI` / `AI_NOT_FOUND`、`toAppError` の KINDS 追加、`errorText` 対応）
  - `src/app/fileActions.ts`（`dialogIssues` を export して共有。挙動は変えない）
  - `src/ai/__tests__/fixtures/{probe.jsonl,error-result.jsonl,tool-error.jsonl,garbage.jsonl}`（probe.jsonl はプローブ出力 `out.jsonl` のパスを匿名化したもの。統括側がスクラッチパッドから渡す）
  - テスト: `src/engine/__tests__/commands.test.ts`（E1〜E5 追加）、`src/ai/__tests__/{parseStream,transcript,summarizeChanges,prompt,aiActions}.test.ts`
- 注: プロンプト文（06§3.1）は `src/ai/prompt.ts` に置く。`src/components` の日本語リテラル禁止ルールは `src/ai` には適用しないが、UI に出す文言（結果カード等）は必ず i18n キー経由（キーの追加は WP11c。本 WP のテストはキー文字列で検証してよい）。
- 受け入れ基準:

| コマンド / 確認 | 期待結果 |
|---|---|
| `pnpm vitest run src/ai` | 06§7.1 の P1〜P6、S1〜S5、A1〜A11 がすべて成功（テスト名に ID を含める） |
| `pnpm vitest run src/engine` | 既存テストに加え E1〜E5 が成功。K16 のパラメタライズドテストに `replaceDocument` が含まれる |
| `grep -rE "from \"(react\|zustand\|@tauri-apps)" src/engine` | 0 件（`equal.ts` も純粋） |
| `grep -rn "src/ai" src/engine` | 0 件（engine は ai に依存しない） |
| A1 の内容 | load → `setName` 1 回 → `importDoc` → `undo()` 1 回で `setName` 後の doc と `toEqual`、もう 1 回で load 直後と `toEqual`。undo スタックの増分は取り込みで 1 |

---

## WP11b AI ペイン: Rust（claude の起動・停止・一時ディレクトリ）

- 目的: `claude -p` を安全な固定引数で起動し、stdout を `ai-event` で流し、終了後に一時ファイルを読み戻して検証結果を返す。
- 参照: 06§0.1, 06§1.2, 06§1.3, 06§5, 06§6, 06§7.2、04§2, 04§6, 04§8, 04§9
- 手順 0（実装前に実施し、結果を報告に書く）: 実物の `claude`（2.1.307）で、プローブのコマンドに `--restricted --permission-prompts none --disable-slash-commands` を足して同じ編集（`t.json` の a:1→2）が成功するか、および「cwd 外のファイル（例: `/tmp/outside.txt`）を Read して内容を答えて」が拒否されるかを確認する。成功した場合のみ `build_args` に `--restricted` を入れる。どちらの結果でも 06§0.1 の該当行を更新する（設計側で文書を直す）。あわせて Edit 失敗時（存在しない old_string）の tool_result の形と、Ctrl+C 相当（SIGTERM）後の `--resume` 継続可否を観測し、行を保存して WP11a のフィクスチャ担当へ渡す。
- 作成/変更: `src-tauri/src/ai.rs`、`src-tauri/src/commands/{ai.rs,mod.rs}`、`src-tauri/src/state.rs`（`AppState.ai`、`remove_window` で破棄）、`src-tauri/src/error.rs`（`Ai` / `AiNotFound`）、`src-tauri/src/lib.rs`（コマンド登録、`RunEvent::Exit` で全セッション破棄、起動時の残骸掃除）、`src-tauri/Cargo.toml`（04§8 の追加分）、`src-tauri/tests/fixtures/{fake-claude-ok.sh,fake-claude-noop.sh,fake-claude-broken.sh,fake-claude-delete.sh,fake-claude-sleep.sh,fake-claude-env.sh,probe.jsonl}`（実行ビット付き）
- 注: `run_process` は Tauri に依存しない関数にし（行コールバックと cancel 受信側を引数に取る）、`commands/ai.rs` は emit と状態管理だけにする。実行ファイル解決は `is_exec` を注入できる純粋関数にする。
- 受け入れ基準:

| コマンド / 確認 | 期待結果 |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml ai` | 06§7.2 の R1〜R12 がすべて成功（R8〜R11 は `#[cfg(unix)]`）。R10 は 3.5 秒以内 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 既存テストを含め全成功（`error.rs` の kind テストに `AI` / `AI_NOT_FOUND` を追加） |
| `grep -n "Command::new(\"sh\"\|Command::new(\"bash\"\|shell" src-tauri/src/ai.rs` | シェル経由の起動が 0 件（テストの偽スクリプトは実行ファイルとして直接起動する） |
| `src-tauri/capabilities/default.json` | 変更なし |
| 手順 0 の報告 | `--restricted` 採否、Edit 失敗時の行、kill 後の resume 可否が書かれている |

---

## WP11c AI ペイン: UI と結合

- 目的: 画面下部の会話ペイン（履歴・入力・実行中表示と停止・ツール進捗・結果カード・高さ変更・折りたたみ）を作り、WP11a/WP11b を結合する。
- 参照: 06§4.2, 06§4.4, 06§4.7〜§4.9、03§1, 03§8.2, 03§16
- 作成/変更: `src/components/AiPane/{AiPane.tsx,MessageList.tsx,ToolActivity.tsx,ResultCard.tsx,Composer.tsx,paneSize.ts}`、`src/components/__tests__/paneSize.test.ts`（U1）、（任意）`Composer.test.tsx`（U2。`@testing-library/react` を入れる場合）、`src/App.tsx`（レイアウトに AiPane、`onAiEvent` の購読、`loadCount` 監視の開始）、`src/styles/app.css`（縦フレックス化、ペインのスタイル）、`src/i18n/ja.json`（06§4.9 の `ai.*`、03§16 の追記分）
- 受け入れ基準:

| コマンド / 確認 | 期待結果 |
|---|---|
| `pnpm vitest run src/components` | 既存テスト + U1（+ U2）成功 |
| `grep -rP "[\p{Han}\p{Hiragana}\p{Katakana}]" src/components` | 0 件（共通ルール） |
| `pnpm dev`（ブラウザ） | ドキュメント表示時にペインが出て、送信すると「デスクトップ版でのみ使えます」。高さドラッグ（最小 120・チャート 200 を残す）と折りたたみが動き、チャートのスクロールが保たれる |
| 手動チェックリスト（`pnpm tauri dev`、macOS、実物の claude） | (1) sample.json を開き「Initiation の下に『要件レビュー』タスクを 2 日で追加して」→ 進捗行（読み込み・編集）が出て、終了後にチャートへ反映、結果カードに「1 タスク追加」、タイトルに ● (2) Cmd+Z（入力欄の外で）または結果カードの［元に戻す］1 回で送信前に戻る (3) 続けて「さっきのタスクを 3 日にして」→ 前の会話を踏まえて編集される（resume） (4) 実行中に［停止］→ 数秒以内に停止し、途中変更があれば［取り込む］［破棄］が出る (5) 実行中にチャートでタスクを動かす → 終了後に docChanged の確認が出る (6) 偽スクリプト `fake-claude-broken.sh`（`aiClaudePath` で指定）で gantt.json を壊す → 「取り込めませんでした」とエラー一覧が出て文書は変わらず、次の送信の文脈にエラーが添えられる（偽スクリプトは受け取った引数を `$TMPDIR/fake-claude-args.txt` に追記するので、そこで確認） (7) 未保存の編集 → AI 取り込み → 保存せずに閉じると未保存確認が出る。元ファイルは Cmd+S まで変わらない（`git diff schema/examples/sample.json` が空） (8) 「新しい会話」で履歴が消え、次の送信が新しいセッションになる (9) Enter 送信・Shift+Enter 改行・日本語変換確定の Enter で送信されない・Esc で停止 (10) 入力欄にフォーカス中、Delete / Tab / 矢印などのチャート用ショートカットが発火しない (11) ウィンドウを閉じると `ps` に claude が残らず、一時ディレクトリ（`$TMPDIR/json-gantt-ai-*`）が消える (12) claude のパスを一時的に変えて（設定値に存在しないパス、候補にも無い状態）送信 → 「claude が見つかりません」と［場所を指定…］、指定後に送信できる (13) 2 つのウィンドウで同時に別々の会話ができる |
| 手動チェック（偽 claude） | 設定値 `aiClaudePath` を `src-tauri/tests/fixtures/fake-claude-ok.sh` に向けて送信 → probe.jsonl の内容がペインに表示され、project.name の変更が取り込まれる（課金なしで UI 全体を確認する手段） |

