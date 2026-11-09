# 04. バックエンド詳細設計（`src-tauri/`）

前提: `docs/ARCHITECTURE.md`、`01-data-model.md`。Rust 側の責務は「ファイル I/O、スキーマ検証、未知フィールド保持、監視、PDF 変換、最近開いたファイル、ネイティブメニュー、ウィンドウ管理」。スケジューリング等のロジックは持たない。

## 1. モジュール構成

```
src-tauri/
  Cargo.toml
  tauri.conf.json
  capabilities/default.json
  resources/fonts/NotoSansJP-Regular.otf   （notofonts/noto-cjk Sans/SubsetOTF/JP の静的 OTF、OFL）
  resources/fonts/NotoSansJP-Bold.otf
  resources/fonts/OFL.txt
  src/
    main.rs            json_gantt_lib::run() を呼ぶだけ
    lib.rs             Builder 構成（プラグイン、状態、コマンド登録、メニュー、RunEvent 処理）
    error.rs           AppError, Issue
    document.rs        serde モデル（§3）
    schema.rs          JSON Schema 検証（§3.3）
    migrate.rs         バージョン移行（§3.4）
    fileio.rs          読み込み・原子的保存・ハッシュ
    watcher.rs         ファイル監視（§5）
    pdf.rs             SVG → PDF（§4）
    menu.rs            ネイティブメニュー（§7）
    state.rs           AppState（ウィンドウ別の監視・保留中オープン）
    commands/mod.rs
    commands/file.rs     open_file, save_file, validate
    commands/pdf.rs      export_pdf
    commands/recent.rs   get_recent_files, add_recent_file
    commands/watch.rs    watch_file, unwatch_file
    commands/window.rs   new_window, focus_window_with_file, take_pending_open
    ai.rs                claude 実行ファイル解決・引数組み立て・プロセス実行（06-ai-pane §5）
    commands/ai.rs       ai_locate, ai_run, ai_stop, ai_reset, ai_set_claude_path
```

スキーマは `include_str!("../../schema/gantt.schema.json")` で埋め込む（唯一の正をそのまま使う）。フォントは `include_bytes!` で埋め込む（実行時のリソースパス解決を不要にする）。

## 2. Tauri コマンド一覧

TS 側の型は `src/tauri/types.ts`、呼び出しラッパは `src/tauri/api.ts`（`invoke` をそのまま露出させない）。引数名は Tauri の規約どおり TS 側 camelCase / Rust 側 snake_case。

| コマンド | 引数 | 戻り値 | エラー |
|---|---|---|---|
| `open_file` | `path: string` | `OpenResult { document: GanttDocument, warnings: Issue[] }` | `IO`, `PARSE_ERROR`, `UNSUPPORTED_VERSION`, `SCHEMA_INVALID` |
| `save_file` | `path: string, document: GanttDocument` | `void` | `IO`, `SCHEMA_INVALID`, `INTERNAL`（デシリアライズ失敗） |
| `validate` | `document: GanttDocument` | `Issue[]`（空なら妥当） | — |
| `export_pdf` | `svg: string, options: PdfOptions` | `string \| null`（保存先パス。保存ダイアログでキャンセルなら null） | `PDF`, `IO` |
| `get_recent_files` | — | `RecentFile[]`（新しい順、最大 10、存在しないものは除外） | — |
| `add_recent_file` | `path: string` | `void` | — |
| `watch_file` | `path: string` | `void`（呼び出し元ウィンドウの監視を置き換える） | `IO` |
| `unwatch_file` | — | `void`（呼び出し元ウィンドウの監視を解除） | — |
| `new_window` | `path?: string \| null`, `blank?: boolean` | `string`（新ウィンドウの label） | `INTERNAL` |
| `focus_window_with_file` | `path: string` | `boolean`（そのパスを監視中のウィンドウがあれば前面化して true） | — |
| `take_pending_open` | — | `string \| null`（呼び出し元ウィンドウ宛ての保留中のパス） | — |
| `ai_locate` | — | `AiSessionInfo { claudePath, dir, ganttPath, schemaPath }`（呼び出し元ウィンドウの AI セッションを無ければ作る。06§5.6） | `AI_NOT_FOUND`, `IO` |
| `ai_run` | `runId: string, document: GanttDocument, prompt: string, appendSystemPrompt: string, resumeSessionId: string \| null` | `AiRunResult`（`claude` の終了まで待つ。06§5.5） | `AI_NOT_FOUND`, `AI`, `IO`, `SCHEMA_INVALID`, `INTERNAL` |
| `ai_stop` | — | `void`（実行中の `claude` をプロセスグループごと停止） | — |
| `ai_reset` | — | `void`（停止し、AI セッションの一時ディレクトリを削除） | — |
| `ai_set_claude_path` | `path: string` | `string`（`settings.json` の `aiClaudePath` に保存したパス） | `AI_NOT_FOUND` |

```ts
// src/tauri/types.ts
export interface Issue { path: string; code: string; message: string; params?: Record<string, string | number> }
export interface OpenResult { document: GanttDocument; warnings: Issue[] }
export interface PdfOptions { pageSize: "A3"; orientation: "landscape"; frozenWidth: number; defaultFileName: string; title: string }
export interface RecentFile { path: string; name: string }   // name = ファイル名
export type AppError =
  | { kind: "IO"; message: string; path?: string }
  | { kind: "PARSE_ERROR"; message: string; line: number; column: number }
  | { kind: "UNSUPPORTED_VERSION"; found: number; supported: number }
  | { kind: "SCHEMA_INVALID"; errors: Issue[] }
  | { kind: "PDF"; message: string }
  | { kind: "INTERNAL"; message: string }
  | { kind: "AI"; message: string }                     // 06-ai-pane: 実行中・spawn 失敗・不正な session id・セッション無し
  | { kind: "AI_NOT_FOUND"; searched: string[] };       // 06-ai-pane: claude 実行ファイルが見つからない（調べたパス）
```

```rust
// error.rs
#[derive(Debug, Serialize, Clone)]
pub struct Issue { pub path: String, pub code: String, pub message: String,
                   #[serde(skip_serializing_if = "Map::is_empty")] pub params: Map<String, Value> }

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AppError {
  #[error("io: {message}")] Io { message: String, #[serde(skip_serializing_if = "Option::is_none")] path: Option<String> },
  #[error("parse: {message}")] ParseError { message: String, line: usize, column: usize },
  #[error("unsupported version {found}")] UnsupportedVersion { found: i64, supported: i64 },
  #[error("schema invalid")] SchemaInvalid { errors: Vec<Issue> },
  #[error("pdf: {message}")] Pdf { message: String },
  #[error("internal: {message}")] Internal { message: String },
  #[error("ai: {message}")] Ai { message: String },                       // 06-ai-pane で追加
  #[error("claude not found")] AiNotFound { searched: Vec<String> },     // 06-ai-pane で追加
}
// SCREAMING_SNAKE_CASE により kind は "IO" / "PARSE_ERROR" / "UNSUPPORTED_VERSION" / "SCHEMA_INVALID" / "PDF" / "INTERNAL" になる（テストで確認する）。
```

- コマンドは `Result<T, AppError>` を返す。フロントの `invoke` は reject 値として `AppError` を受け取る。
- `open_file` / `save_file` / `watch_file` は `window: tauri::Window` を受け、ラベル単位で `AppState` を更新する（§5）。
- `export_pdf` と保存系は `async fn`（Tauri の非同期コマンドとしてメインスレッド外で実行。ダイアログの `blocking_save_file` をメインスレッドで呼ばないため）。

### 2.1 open_file の処理

1. `std::fs::read`。失敗 → `IO`。
2. 先頭 UTF-8 BOM（EF BB BF）を除去。UTF-8 でなければ `IO { message: "not UTF-8" }`。
3. `serde_json::from_str::<Value>`。失敗 → `PARSE_ERROR { line, column }`（`serde_json::Error::line/column`）。
4. `migrate::run(value)`（§3.4）。新しすぎる → `UNSUPPORTED_VERSION`。移行したら warning `MIGRATED`。
5. `schema::validate(&value)`。違反 → `SCHEMA_INVALID`。
6. `serde_json::from_value::<GanttDocument>`。失敗（スキーマ通過後は起きない想定）→ `INTERNAL`。
7. warning `UNKNOWN_FIELDS`: 全オブジェクトの `extra` が空でなければ、各未知キーの JSON Pointer を列挙（1 件の Issue、`params.paths` にカンマ区切りで最大 20 件）。
8. 呼び出し元ウィンドウの `AppState.windows[label]` を `{ path, known_hash: 読み込んだバイト列の SHA-256, removed: false }` に設定（既存の debouncer は path が変わる場合 drop）。
9. `OpenResult { document: serde_json::to_value(doc), warnings }` を返す。

### 2.2 save_file の処理

1. `serde_json::from_value::<GanttDocument>(document)`。失敗 → `INTERNAL`。
2. 親タスク（いずれかの `parent_id` に現れる id。小文字化して比較）の `start/end/progress/hours` を `None` に（01-data-model §5.1 の防御）。
3. `serde_json::to_value` → `schema::validate`。違反 → `SCHEMA_INVALID`（保存しない）。
4. `serde_json::to_string_pretty`（2 スペース）+ `"\n"` → バイト列。
5. `known_hash` を新しいバイト列のハッシュに更新（**書き込み前に**。監視イベントとの競合で自分の保存を外部変更と誤認しないため）。
6. 原子的書き込み: 同じディレクトリに `.{file_name}.json-gantt.tmp` を作成 → 書き込み → `sync_all` → `std::fs::rename` で置換。Windows で rename が失敗した場合（対象が他プロセスで開かれている等）は最大 3 回 100ms 間隔で再試行し、それでも失敗なら一時ファイルを削除して `IO`。
7. 元ファイルのパーミッションは保持しない（新規作成と同じ既定権限）。

## 3. serde モデル（`document.rs`）

フィールドの宣言順 = 書き出し時のキー順（01-data-model §2）。`extra` は必ず最後のフィールドにする（flatten されたマップは宣言位置で出力されるため、末尾に置くと未知キーが既知キーの後ろに並ぶ）。`serde_json` の `preserve_order` 機能で未知キーの順序を保持する。

```rust
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GanttDocument {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub version: i64,
    pub project: Project,
    #[serde(default)]
    pub resources: Vec<Resource>,
    #[serde(rename = "colorLabels", default)]
    pub color_labels: Vec<ColorLabel>,
    pub tasks: Vec<Task>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<ViewSettings>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar: Option<Calendar>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Calendar {
    pub weekends: Vec<u8>,
    pub holidays: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resource {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColorLabel {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    #[serde(rename = "parentId", default)]           // 欠損 → None。None でも null として必ず書く
    pub parent_id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hours: Option<Number>,                        // 8 は 8、8.5 は 8.5 のまま書く（f64 だと 8.0 になる）
    #[serde(rename = "resourceIds", default)]
    pub resource_ids: Vec<String>,
    #[serde(rename = "colorLabelId", default, skip_serializing_if = "Option::is_none")]
    pub color_label_id: Option<String>,
    #[serde(default)]
    pub dependencies: Vec<Dependency>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dependency {
    #[serde(rename = "predecessorId")]
    pub predecessor_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lag: Option<i64>,                             // 読んだ値（0 を含む）をそのまま保持
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<String>,                          // "day" | "week" | "month"（検証はスキーマ）
    #[serde(rename = "collapsedTaskIds", default)]
    pub collapsed_task_ids: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
```

注意:
- `#[serde(flatten)]` と `deny_unknown_fields` は併用しない。`serde_json` の `arbitrary_precision` 機能は有効にしない（flatten と相性が悪い）。
- `version` は `i64`（スキーマで const 1 を検証済み）。
- Rust モデルの変更は、スキーマ → `pnpm gen:types` → 本ファイル の順で同期する（ARCHITECTURE）。

### 3.1 cargo test（`document.rs` / `fileio.rs`）

| テスト | 期待 |
|---|---|
| `roundtrip_sample` | `schema/examples/sample.json` を読み → `GanttDocument` → 書き出し文字列がファイルとバイト一致 |
| `roundtrip_unknown_fields` | トップ・project・calendar・resource・colorLabel・task・dependency・view に未知キーを 1 つずつ（値はネストしたオブジェクト・配列・小数を含む）入れたフィクスチャがバイト一致 |
| `key_order` | キー順をバラバラにした入力を書き出すとスキーマ順になり、未知キーは末尾 |
| `hours_number_repr` | `hours: 8` → `8`、`hours: 7.5` → `7.5` |
| `parent_fields_stripped_on_save` | 親タスクに `start` を入れて save 処理 → 出力に無い |
| `parent_id_null_written` | `parentId` 欠損の入力 → 出力に `"parentId": null` |
| `atomic_save` | `tempfile` ディレクトリで保存後、一時ファイルが残らない、末尾が `\n` |

### 3.2 フロント ⇄ Rust の受け渡し

`invoke` の引数は JSON シリアライズされるので、フロントの `GanttDocument`（未知キーを含む素のオブジェクト）はそのまま渡る。Rust からの `document` は `serde_json::Value` で返し、フロントはそれを `GanttDocument` として扱う。

### 3.3 スキーマ検証（`schema.rs`）

```rust
static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
fn validator() -> &'static jsonschema::Validator {
    VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(include_str!("../../schema/gantt.schema.json")).expect("schema json");
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .should_validate_formats(true)
            .build(&schema)
            .expect("valid schema")
    })
}
pub fn validate(instance: &Value) -> Vec<Issue>;
```

- `validator().iter_errors(instance)` の各エラーを `Issue` に変換: `path = error.instance_path().to_string()`（JSON Pointer。ルートは `""` → `"/"` と表示）、`message = error.to_string()`（英語）、`code` と `params` は `error.kind()` から:

| ValidationErrorKind | code | params |
|---|---|---|
| `Required { property }` | `required` | `property`（文字列値） |
| `Type { kind }` | `type` | `expected`（`kind` の Debug 表記を小文字化） |
| `Pattern { .. }` | `pattern` | — |
| `Format { format }` | `format` | `format` |
| `Enum { .. }` | `enum` | — |
| `Constant { expected_value }` | `const` | `expected` |
| `Minimum { limit }` / `Maximum { limit }` | `minimum` / `maximum` | `limit` |
| `UniqueItems` | `uniqueItems` | — |
| `OneOfNotValid` / `OneOfMultipleValid` | `oneOf` | — |
| その他 | `other` | — |

  バリアント名・フィールド名は jsonschema 0.59 の定義に合わせる（差異があれば同等のものに対応させ、本表を更新）。
- `path` 昇順で安定ソート、同一 `(path, code)` は 1 件に。最大 500 件。
- 依存: `jsonschema = { version = "0.59", default-features = false }`（リモート参照解決・TLS を含めない。スキーマは自己完結）。
- テスト: sample.json → 0 件。`/tasks/0/start = "2023-13-01"` → `pattern` と `format`。`/version = 2` → `const`。`progress = 101` → `maximum`。`tasks` 欠損 → `required`（path `/`）。

### 3.4 バージョン移行（`migrate.rs`）

```rust
pub const CURRENT_VERSION: i64 = 1;
pub fn run(value: Value) -> Result<(Value, Option<(i64, i64)>), AppError>
```

- `value["version"]` が整数でなければそのまま返す（スキーマ検証で `required` / `type` エラーになる）。
- `> CURRENT_VERSION` → `UnsupportedVersion { found, supported: CURRENT_VERSION }`。
- `< CURRENT_VERSION` → `migrate_v{n}_to_v{n+1}` を順に適用し `Some((from, CURRENT_VERSION))`。現行は移行関数なし（v1 未満は存在しない → `version < 1` は `UnsupportedVersion` ではなくスキーマの `const` エラーに任せる）。

## 4. PDF パイプライン（`pdf.rs`, `commands/pdf.rs`）

### 4.1 依存クレートの整合

`svg2pdf 0.13.0` は `usvg ^0.45` と `pdf-writer ^0.12` に依存する。**usvg は直接依存に入れず `svg2pdf::usvg` の再エクスポートを使う**。`pdf-writer` は svg2pdf と同じ `0.12` を指定する（`Chunk` / `Ref` の型を一致させるため）。WP0 の Cargo.toml にある `usvg = "0.48.1"` と `pdf-writer = "0.15.0"` は WP5 で修正する（§8）。

### 4.2 フォント

```rust
static REGULAR: &[u8] = include_bytes!("../resources/fonts/NotoSansJP-Regular.otf");
static BOLD:    &[u8] = include_bytes!("../resources/fonts/NotoSansJP-Bold.otf");

fn usvg_options() -> svg2pdf::usvg::Options<'static> {
    let mut opt = svg2pdf::usvg::Options::default();
    opt.font_family = "Noto Sans JP".to_string();
    let db = opt.fontdb_mut();
    db.load_font_data(REGULAR.to_vec());
    db.load_font_data(BOLD.to_vec());
    db.set_sans_serif_family("Noto Sans JP");
    opt
}
```

- システムフォントは読み込まない（出力を環境非依存にする）。フォントは notofonts/noto-cjk 配布の Noto Sans JP 静的サブセット OTF（CFF、Regular 400 / Bold 700、各約 4.5MB）。Google Fonts には静的 TTF が無く可変 TTF のみのため、可変フォントは使わない。
- svg2pdf の `ConversionOptions { embed_text: true, compress: true, .. }`（既定）でサブセット埋め込みされる。

### 4.3 ページ割り付け

単位: SVG の 1px を基準倍率 `S0 = 0.75 pt`（96dpi 相当）とする。

```
A3 横: PW = 1190.55 pt, PH = 841.89 pt（420×297 mm）。余白 M = 28.35 pt（10 mm）
AW = PW - 2M = 1133.85,  AH = PH - 2M = 785.19
W, H = SVG の width/height（px）, F = options.frozenWidth（px）
MIN_SCALE = 0.45  // pt/px。11px の文字が約 5pt

s_fit = min(S0, AW / W, AH / H)
if s_fit >= MIN_SCALE:                       // 全体を 1 ページに縮小
    pages = 1, s = s_fit
else:                                        // 高さは 1 ページに収め、横方向に分割
    s = min(S0, AH / H, MIN_SCALE)
    if F * s > AW / 2: F = 0                  // 固定列がページ幅の半分を超えるなら繰り返さない
    slice = AW / s - F                        // 1 ページに載るタイムライン幅（px）
    T = W - F
    pages = ceil(T / slice)
```

- 縦方向の分割はしない（要件は横分割のみ）。行数が非常に多い場合は縮小率が MIN_SCALE を下回って 1 ページの高さに収める。
- 2 ページ目以降も左 `F` px（表＋タイトル帯）を繰り返し、その右にタイムラインの続きを置く。

### 4.4 PDF の組み立て

1. `tree = usvg::Tree::from_str(&svg, &usvg_options())`。失敗 → `PDF { message }`。
2. `(chunk, svg_ref) = svg2pdf::to_chunk(&tree, ConversionOptions::default())`。chunk を `renumber` してページ用の参照と衝突しないように割り当て直す（svg2pdf の doc の例と同じ方法）。
   - `to_chunk` の Form XObject は単位正方形に正規化されている（`matrix [1/w,0,0,1/h]`）。配置は `cm [W·s, 0, 0, H·s, tx, ty]` で行う。
3. `pdf_writer::Pdf` に catalog / page tree / 各ページ（MediaBox `[0 0 PW PH]`）/ 各ページの content stream / 文書情報（`Title = options.title`, `Creator = "json-gantt"`）を書き、`pdf.extend(&chunk)`。
4. 各ページ i（0 始まり）の content stream（`ty = PH - M - H·s`、XObject 名 `/S1`）:

```
単一ページ:
  q  W·s 0 0 H·s M ty cm  /S1 Do  Q
分割ページ i:
  # 固定列（F > 0 のとき）
  q  M ty (F·s) (H·s) re W n   W·s 0 0 H·s M ty cm  /S1 Do  Q
  # タイムラインの i 番目のスライス
  x0 = F + i·slice ;  w_i = min(slice, W - x0)
  q  (M + F·s) ty (w_i·s) (H·s) re W n   W·s 0 0 H·s (M + F·s - x0·s) ty cm  /S1 Do  Q
```

   XObject は 1 つだけ作り全ページから参照する（ファイルサイズを抑える）。これが ARCHITECTURE の「viewBox を横にスライス」の実装である（SVG 文字列を書き換える代わりに、同じ図をクリップ＋平行移動して描く。見た目は viewBox を横にずらしたものと同一）。
5. 保存先: `app.dialog().file().add_filter("PDF", &["pdf"]).set_file_name(&options.default_file_name).blocking_save_file()`。None → `Ok(None)`。拡張子が無ければ `.pdf` を付ける。`std::fs::write`（原子的書き込みは不要）。
6. `Ok(Some(path))`。

テスト（cargo test, `pdf.rs`）:
- `layout_single_page`: W=1200, H=800 → pages 1, s = min(0.75, 0.9449, 0.9815) = 0.75。
- `layout_split`: W=6000, H=800, F=330 → s_fit = 0.189 < 0.45 → s = 0.45、slice = 1133.85/0.45 - 330 = 2189.67、T = 5670 → pages 3。
- `pdf_smoke`: 日本語テキスト「テスト」を含む小さな SVG → PDF バイト列が `%PDF-` で始まり、`/FontFile2`（埋め込みフォント）を含む。

### 4.5 PdfOptions（Rust）

```rust
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct PdfOptions { pub page_size: String /* "A3" のみ */, pub orientation: String /* "landscape" のみ */,
                        pub frozen_width: f64, pub default_file_name: String, pub title: String }
```
`page_size != "A3"` または `orientation != "landscape"` → `PDF { message: "unsupported page" }`（将来拡張用の引数。現状は固定値）。

## 5. ファイル監視（`watcher.rs`, `state.rs`）

```rust
pub struct WindowFile { pub path: PathBuf, pub known_hash: Option<[u8; 32]>, pub removed: bool,
                        pub debouncer: Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>> }
pub struct AppState {
    pub windows: Mutex<HashMap<String /* window label */, WindowFile>>,
    pub pending_open: Mutex<HashMap<String /* label */, Vec<PathBuf>>>,
    pub ready: Mutex<HashSet<String /* label */>>,
}
```

- `watch_file(path)`: 既存の debouncer を drop して置き換え。`notify_debouncer_mini::new_debouncer(Duration::from_millis(300), handler)` を作り、**ファイルの親ディレクトリ**を `NonRecursive` で監視（エディタの「一時ファイルに書いて rename」型の保存でも追跡するため）。`known_hash` は `open_file`/`save_file` が設定した値を維持（未設定なら現在の内容のハッシュ）。
- handler（監視スレッド）: イベントのパスのうち監視対象と一致するもの（`canonicalize` できない場合はファイル名比較）があれば:
  - ファイルが存在する: 読み込んで SHA-256。`known_hash` と異なれば `known_hash` を更新し、`removed = false`、そのウィンドウに `file-changed-externally { path, kind: "modified" }` を emit。同じなら何もしない（自分の保存・内容の変わらない touch）。
  - 存在しない: `removed == false` なら `removed = true` にして `{ kind: "removed" }` を emit。
- `unwatch_file`、ウィンドウ破棄（`WindowEvent::Destroyed`）で該当エントリを削除。
- `save_file` は §2.2 の 5 で `known_hash` を先に更新するので、自分の保存は通知されない。
- ハッシュは `sha2 = "0.10"` の `Sha256`。

## 6. イベント

| イベント | 方向 | payload | 発火条件 |
|---|---|---|---|
| `file-changed-externally` | Rust → 該当ウィンドウ | `{ path: string, kind: "modified" \| "removed" }` | §5 |
| `open-file-requested` | Rust → ウィンドウ | `{ path: string }` | 起動後に OS からファイルを開く要求（macOS: Finder/Dock、Windows: 2 つ目のインスタンス起動引数） |
| `menu-action` | Rust → フォーカス中のウィンドウ | `{ action: "new" \| "open" \| "save" \| "saveAs" \| "exportPdf" \| "undo" \| "redo" }` | §7 のメニュー選択・アクセラレータ |
| `ai-event` | Rust → `ai_run` を呼んだウィンドウ（`emit_to(label)`） | `{ runId: string, line: string }`（`claude` の stream-json 1 行をそのまま） | `claude` の stdout 1 行ごと（06§5.5） |

ファイルを開く要求の経路:
- 起動引数（初回起動、macOS / Windows 共通）: `std::env::args().skip(1)` の中で `.json` で終わる既存ファイルを `pending_open["main"]` に積む。
- macOS: `RunEvent::Opened { urls }` の `file://` URL をパスにする。宛先ウィンドウ（フォーカス中、無ければ `main`）が `ready` に入っていなければ `pending_open` に積み、入っていれば `open-file-requested` を emit。
- Windows: `tauri-plugin-single-instance` のコールバック `(app, argv, cwd)` で argv 中の `.json` を同様に処理し、宛先ウィンドウを前面化。
- フロントはマウント時に `take_pending_open()` を呼ぶ（このときウィンドウを `ready` に登録）。戻り値があれば開く。以後は `open-file-requested` を購読する。開く処理は 03-ui §14（空のウィンドウならその場、そうでなければ `new_window(path)`）。
- D&D はフロントのみで処理する（Tauri 2 の webview `onDragDropEvent`。Rust のイベントは使わない）。

`new_window(path, blank)`（どちらも省略可）: label `doc-{連番}`、`WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))`（`blank == true` なら `index.html?new=1`。フロントは起動時に `new=1` を見て新規作成する）、タイトル "json-gantt"、サイズ 1400×860、最小 1024×640。path があれば `pending_open[label]` に積む。

`focus_window_with_file(path)`: `windows` を走査し、`path` が一致（canonicalize 比較）するラベルのウィンドウを `set_focus` して true。

## 7. ネイティブメニュー（`menu.rs`）

文言はフロントの `src/i18n/ja.json` の `menu.*` を `include_str!("../../src/i18n/ja.json")` で読み込んで使う（文言の単一ソース）。

| メニュー | 項目 | アクセラレータ | 動作 |
|---|---|---|---|
| （macOS のみ）アプリ | About / Hide / Hide Others / Show All / Quit | 既定 | Predefined |
| ファイル | 新規 | `CmdOrCtrl+N` | `menu-action: new` |
| | 開く… | `CmdOrCtrl+O` | `open` |
| | 保存 | `CmdOrCtrl+S` | `save` |
| | 名前を付けて保存… | `CmdOrCtrl+Shift+S` | `saveAs` |
| | PDF 出力… | `CmdOrCtrl+Shift+E` | `exportPdf` |
| | ウィンドウを閉じる | `CmdOrCtrl+W` | Predefined `close_window`（→ `onCloseRequested` で未保存確認） |
| 編集 | 元に戻す | `CmdOrCtrl+Z` | `undo` |
| | やり直す | `CmdOrCtrl+Shift+Z` | `redo` |
| | カット / コピー / ペースト / すべて選択 | 既定 | Predefined（入力欄用） |

- Undo / Redo は Predefined ではなくカスタム項目にする（アプリの Undo とテキスト入力の Undo をフロントで振り分けるため。03-ui §8.2）。
- `app.on_menu_event` で id → action に変換し、フォーカス中のウィンドウ（`app.webview_windows()` で `is_focused()`、無ければ `main`）に `emit_to`。
- 終了項目は `PredefinedMenuItem::quit` を使わず、カスタム項目 `quit`（`CmdOrCtrl+Q`）にする。選択時は全 webview window に `close()` を送り、フロントの `onCloseRequested` による未保存確認を通す。macOS ではアプリメニュー、Windows/Linux ではファイルメニュー末尾に置く。
- 文言は `build.rs` の `rerun-if-changed` で ja.json の変更時に再コンパイルされる。`menu.*` に無いキー（`close`、`quit`）はコード内のフォールバック文字列を使う。

### 既知の制約（終了時の未保存確認）

muda の Quit は `terminate:` を直接送り、tao は `applicationShouldTerminate:` を実装していないため、`RunEvent::ExitRequested` では macOS のアプリ終了を止められない。カスタム項目で Cmd+Q は救えるが、次の経路では未保存確認が出ずに終了する: Dock の「終了」、ログアウト/シャットダウン、`osascript -e 'quit app'`。未保存データの保護はこれらについては保証しない。
- Windows でもメニューバーを各ウィンドウに表示する。

## 8. Cargo 依存

```toml
[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = { version = "1", features = ["preserve_order"] }
thiserror = "2"
tauri-plugin-dialog = "2"
tauri-plugin-store = "2"
jsonschema = { version = "0.59", default-features = false }
notify = "8.2"
notify-debouncer-mini = "0.7"
svg2pdf = "0.13"          # usvg は svg2pdf::usvg を使う（直接依存しない）
pdf-writer = "0.12"       # svg2pdf 0.13 と同じ版にそろえる
sha2 = "0.10"

[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]
tauri-plugin-single-instance = "2"

[dev-dependencies]
tempfile = "3"
```

06-ai-pane（WP11b）での追加: `tokio = { version = "1", features = ["process", "io-util", "time", "sync", "macros", "rt"] }`（Tauri の tokio と同じ 1.x に解決させる）、`tempfile = "3"` を `[dependencies]` に移動、`[target.'cfg(unix)'.dependencies] libc = "0.2"`（`killpg`）。

WP0 からの変更点: `usvg` 削除、`pdf-writer` を 0.12 に、`tauri-plugin-fs` 削除（フロントからファイルシステムへ直接アクセスしない。I/O はすべて独自コマンド経由）、`uuid` 削除（ID 生成はフロント）、`notify-debouncer-mini` / `sha2` / `tauri-plugin-single-instance` / `tempfile` 追加。`package.json` からも `@tauri-apps/plugin-fs` と `@tauri-apps/plugin-store` を削除する（store は Rust 側の `StoreExt` だけで使う）。

## 9. 設定保存（tauri-plugin-store、Rust 側）

ストアファイル `settings.json`（アプリのデータディレクトリ）。

| キー | 型 | 用途 |
|---|---|---|
| `recentFiles` | `string[]` | 最近開いたファイル（絶対パス、新しい順、最大 10）。`add_recent_file` は先頭に入れて重複除去（canonicalize 比較）。`get_recent_files` は存在しないパスを除いて返し、除いた結果を保存 |
| `windowState` | `{ width, height, x, y, maximized }` | `main` ウィンドウのみ。`CloseRequested` 時に保存、起動時に復元（画面外なら復元しない） |
| `aiClaudePath` | `string` | `claude` 実行ファイルの場所（ユーザーが指定した場合のみ。06§5.3 の候補 1） |

## 10. tauri.conf.json と capabilities

`tauri.conf.json`（要点）:

```json
{
  "productName": "json-gantt",
  "identifier": "<WP0 の値を維持>",
  "app": {
    "windows": [
      { "label": "main", "title": "json-gantt", "width": 1400, "height": 860,
        "minWidth": 1024, "minHeight": 640, "dragDropEnabled": true }
    ],
    "security": { "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost" }
  },
  "bundle": {
    "fileAssociations": [
      { "ext": ["json"], "name": "json-gantt document", "role": "Editor", "rank": "Alternate" }
    ]
  }
}
```

- `fileAssociations` は macOS の「このアプリケーションで開く」に出すため。`rank: "Alternate"` で .json の既定アプリを奪わない。（Tauri 2 の `FileAssociation` に `rank` が無い版なら省略してよい。**要確認**: 実装時に tauri-utils のスキーマで確認）
- `dragDropEnabled: true`（既定値だが明示）。これで webview の `onDragDropEvent` がファイルパスを受け取る。

`capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["main", "doc-*"],
  "permissions": [
    "core:default",
    "core:window:allow-set-title",
    "core:window:allow-set-focus",
    "core:window:allow-destroy",
    "dialog:allow-open",
    "dialog:allow-save"
  ]
}
```

- **fs**: フロントには許可しない（I/O はすべて独自コマンド。最小権限）。
- **dialog**: ファイル選択（open/save）のみ許可。PDF の保存ダイアログは Rust 側から出す。確認ダイアログは React で描くので `ask/message` は不要。
- **store**: Rust 側の `StoreExt` だけで使うのでフロント権限は不要。プラグイン自体は `tauri_plugin_store::Builder::default().build()` で登録する。
- **drag-drop**: 権限項目ではなく、ウィンドウ設定 `dragDropEnabled` と `core:default`（イベント購読）で有効。
- 独自コマンドは Tauri 2 の既定でアプリのコマンドとして許可される（`build.rs` で `AppManifest` の制限を設けない）。
- `core:window:allow-destroy`: 未保存確認後に `onCloseRequested` の中から確実に閉じるため。
- AI ペイン（06）による追加権限は無い: `ai-event` の購読は `core:default` に含まれるイベント権限、`claude` の起動は独自コマンド（Rust が固定の引数で起動）、実行ファイルの選択は既存の `dialog:allow-open`。`shell` / `fs` プラグインは引き続き使わない。CSP も変更しない。
