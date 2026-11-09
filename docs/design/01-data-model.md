# 01. データモデル詳細設計

対象: `schema/gantt.schema.json`（唯一の正）、`schema/examples/sample.json`、`src/model/`、`src/engine/document.ts`、`src-tauri/src/document.rs`。
前提: `docs/ARCHITECTURE.md`。本書はその範囲内の詳細。

---

## 1. 用語

| 用語 | 定義 |
|---|---|
| ドキュメント | 1 つの JSON ファイルの内容全体（`GanttDocument`） |
| 親タスク | 他のいずれかのタスクから `parentId` で参照されているタスク |
| リーフタスク | 親タスクでないタスク |
| 導出値 | 親タスクの `start` / `end` / `progress` / `hours`。子から計算し、JSON には書かない |
| 稼働日 | `project.calendar` があれば「`weekends` に含まれない曜日」かつ「`holidays` に含まれない日」。なければ全日 |
| 期間（duration） | `[start, end]`（両端包含）に含まれる稼働日数 |
| 表示順 | ルートから深さ優先・前順で、兄弟は配列内の相対順に並べた順序 |

---

## 2. フィールド定義

### 2.1 トップレベル `GanttDocument`

キー順（書き出し時の順序）は下表の順。

| キー | 型 | 必須 | 意味 / 既定値 |
|---|---|---|---|
| `$schema` | string | 任意 | エディタ補完用。解釈せず保持。無ければ書かない |
| `version` | integer (const 1) | 必須 | フォーマットバージョン。§6 |
| `project` | Project | 必須 | プロジェクト情報 |
| `resources` | Resource[] | 任意（既定 `[]`） | リソース一覧。書き出し時は空でも必ず書く |
| `colorLabels` | ColorLabel[] | 任意（既定 `[]`） | 色ラベル一覧。書き出し時は空でも必ず書く |
| `tasks` | Task[] | 必須 | タスクのフラット配列 |
| `view` | ViewSettings | 任意 | 表示状態。アプリは書き出し時に必ず書く（§5.2） |
| （未知キー） | any | — | 保持し、上記の後ろに読み込み時の順序で書く |

### 2.2 `Project`

| キー | 型 | 必須 | 意味 |
|---|---|---|---|
| `name` | string | 必須 | プロジェクト名。ウィンドウタイトルでなく右パネル Project タブに表示 |
| `description` | string | 任意 | 説明。空文字に編集されたらキーごと削除 |
| `calendar` | Calendar | 任意 | 稼働日設定。無ければ全日稼働 |

### 2.3 `Calendar`

| キー | 型 | 必須 | 意味 |
|---|---|---|---|
| `weekends` | integer[]（0..6、重複不可、最大 6 個） | 必須 | 非稼働曜日。0=日曜 |
| `holidays` | date[]（重複不可） | 必須 | 非稼働日。書き出し時は昇順ソート |

`weekends` は最大 6 個（全曜日を非稼働にすると稼働日が存在せず計算が停止するため）。

### 2.4 `Resource` / `ColorLabel`

| キー | 型 | 必須 | 意味 |
|---|---|---|---|
| `id` | uuid | 必須 | 一意 ID |
| `name` | string | 必須 | 表示名 |
| `color` | `#RRGGBB` | Resource は任意 / ColorLabel は必須 | 表示色 |

Resource の `color` は右パネルのリソースチップの色に使う。未指定時はチップをグレー（`#9E9E9E`）で表示する。

### 2.5 `Task`

キー順: `id, parentId, name, start, end, progress, hours, resourceIds, colorLabelId, dependencies, notes, (未知キー)`。

| キー | 型 | 必須（スキーマ） | リーフ | 親 | 既定値・備考 |
|---|---|---|---|---|---|
| `id` | uuid | 必須 | ○ | ○ | |
| `parentId` | uuid \| null | 任意 | ○ | ○ | 省略は null。**書き出し時は null でも必ず書く** |
| `name` | string | 必須 | ○ | ○ | 空文字可 |
| `start` | date | 任意 | 必須（§4.2） | 無視 | |
| `end` | date | 任意 | 必須（§4.2） | 無視 | 包含 |
| `progress` | integer 0..100 | 任意 | 既定 0。書き出し時は必ず書く | 無視 | |
| `hours` | number ≥ 0 | 任意 | 任意 | 無視 | 小数可。無ければ書かない |
| `resourceIds` | uuid[]（重複不可） | 任意 | ○ | ○（保存する） | 既定 `[]`。書き出し時は必ず書く |
| `colorLabelId` | uuid | 任意 | ○ | ○ | 無ければ書かない |
| `dependencies` | Dependency[] | 任意 | ○ | ○ | 既定 `[]`。書き出し時は必ず書く |
| `notes` | string | 任意 | ○ | ○ | 空文字に編集されたらキーごと削除 |

親タスクの `resourceIds` / `colorLabelId` / `dependencies` / `notes` は導出値ではなく保存対象。

### 2.6 `Dependency`

| キー | 型 | 必須 | 意味 |
|---|---|---|---|
| `predecessorId` | uuid | 必須 | 先行タスク id。依存は**後続側**のタスクに置く |
| `lag` | integer | 任意（既定 0） | 暦日のラグ。負値はリード。読み込んだ値はそのまま保持し、アプリが新規作成する依存には書かない |

制約式（02-engine.md §3.1 で定義）: `successor.start >= nextWorkingDay(addDays(predecessor.end, 1 + lag))`

### 2.7 `ViewSettings`

| キー | 型 | 既定 | 意味 |
|---|---|---|---|
| `zoom` | `"day" \| "week" \| "month"` | `"day"` | タイムラインのズーム |
| `collapsedTaskIds` | uuid[] | `[]` | 折りたたまれた親タスク id |

---

## 3. 不変条件

読み込み時に検証し（§4.3）、エンジンの全コマンドは結果ドキュメントでもこれを保つ。

| # | 不変条件 | 違反時（読み込み） |
|---|---|---|
| I1 | `tasks[].id` が一意。`resources[].id` が一意。`colorLabels[].id` が一意（ID 空間はこの 3 種で別。大文字小文字は区別しない＝比較は小文字化して行う） | エラー `DUPLICATE_ID` |
| I2 | `parentId` が null でなければ、存在するタスク id | エラー `PARENT_NOT_FOUND` |
| I3 | 親子関係が循環しない（自分自身を親にするのも循環） | エラー `PARENT_CYCLE` |
| I4 | `dependencies[].predecessorId` が存在するタスク id で、自分自身でない | エラー `DEPENDENCY_NOT_FOUND` / `DEPENDENCY_SELF` |
| I5 | 同一タスク内で同じ `predecessorId` が重複しない | エラー `DEPENDENCY_DUPLICATE` |
| I6 | 依存が祖先・子孫間に張られていない（タスクとその祖先/子孫を結ぶ依存は禁止） | エラー `DEPENDENCY_ANCESTOR` |
| I7 | 依存グラフ（02-engine §3.4 の S/E グラフ）が循環しない | エラー `DEPENDENCY_CYCLE` |
| I8 | リーフタスクは `start` と `end` を持ち `start <= end` | 片方欠損は補完（§4.2）。両方欠損はエラー `LEAF_NO_DATES`。`start > end` はエラー `START_AFTER_END` |
| I9 | リーフのみが `start/end/progress/hours` を持つ（親の値は無視・除去） | 警告 `PARENT_DERIVED_IGNORED`（除去して開く） |
| I10 | `resourceIds[]` は存在する resource id、`colorLabelId` は存在する colorLabel id | 警告 `UNKNOWN_RESOURCE` / `UNKNOWN_COLOR_LABEL`（値は保持し表示では無視） |
| I11 | `view.collapsedTaskIds[]` は存在する**親**タスク id | 警告なしで無視。書き出し時に除外（§5.2） |
| I12 | FS 制約がすべて満たされている | 警告 `DEPENDENCY_VIOLATION`（値は変更せずに開く。02-engine §3.6） |

補足:
- I8 の比較は文字列比較でよい（`YYYY-MM-DD` 固定長のため辞書順 = 日付順）。
- 稼働日でない日に `start` / `end` があっても不正ではない（期間は稼働日数で数え、0 になり得る）。エンジンのコマンドは結果を稼働日に揃える（02-engine §1.3）。

---

## 4. 読み込みと正規化

### 4.1 パイプライン

```
[Rust] open_file(path)
  1. ファイル読み込み（UTF-8、先頭 BOM は除去）
  2. JSON パース失敗 → エラー PARSE_ERROR（行・列付き）
  3. version 判定・移行（§6）
  4. JSON Schema 検証（jsonschema, draft 2020-12, format 検証有効）→ 違反があれば SCHEMA_INVALID（全エラー一覧）
  5. serde で GanttDocument へデシリアライズ（未知キーは extra に保持）
  6. Rust 側警告の収集（UNKNOWN_FIELDS）
  7. { document, warnings } を返す
[TS] engine/document.ts: loadDocument(raw, ctx)
  8. 意味検証（I1〜I7, I8 の両方欠損/逆転）→ エラーがあれば開かない（エラーダイアログ）
  9. 正規化（§4.2）
 10. 警告（I9, I10, I12）を収集
 11. { document, warnings } を store に渡す
```

意味検証（手順 8）を TS 側に置く理由: 階層・依存グラフの処理はエンジンに集約するため（ARCHITECTURE「ロジックは engine に集める」）。スキーマ検証は Rust 側（ARCHITECTURE 指定）。エラーダイアログは両者を同じ形式（`{ path, code, message }`）で表示する。

### 4.2 正規化ルール（`normalizeDocument`）

正規化はドキュメントを**変更するが dirty にしない**（保存すると正規化後の形で書かれる）。

1. `resources` / `colorLabels` 欠損 → `[]`。
2. 各タスク:
   - `parentId` 欠損 → `null`
   - `resourceIds` 欠損 → `[]`、`dependencies` 欠損 → `[]`
   - リーフで `progress` 欠損 → `0`
   - リーフで `start` のみ → `end = start`。`end` のみ → `start = end`
   - 親タスクの `start` / `end` / `progress` / `hours` → **削除**（I9 警告。件数を warning の params に入れる）
   - `dependencies[].lag` は欠損のまま（0 扱い）。値 0 が書かれていれば保持
3. `tasks` 配列を**表示順（深さ優先前順）に並べ替える**。兄弟の相対順は元配列の順を維持（安定）。並べ替えは値を変えないので警告は出さない。
4. `view` 欠損 → `{ zoom: "day", collapsedTaskIds: [] }`。`view.zoom` 欠損 → `"day"`、`collapsedTaskIds` 欠損 → `[]`。
5. ID の大文字小文字は**変更しない**（比較時のみ小文字化）。新規生成 ID は小文字。

> 実装注: 比較用に `idKey(id) = id.toLowerCase()` をすべての Map のキーに使う。`src/model/id.ts` に置く。

### 4.3 導出値の計算

導出値はドキュメントに入れず、`engine/hierarchy.ts` の `deriveAll(doc)` が `DerivedIndex` として返す（メモ化は store のセレクタで行う）。

```ts
interface DerivedTask {
  id: string;
  isParent: boolean;
  depth: number;            // ルート = 0
  childIds: string[];       // 表示順
  start: IsoDate;           // リーフ: 自値 / 親: min(子 start)
  end: IsoDate;             // リーフ: 自値 / 親: max(子 end)
  durationDays: number;     // workingDaysBetween(start, end)
  hours: number | undefined;// リーフ: 自値 / 親: Σ子（全子が undefined なら undefined）
  progress: number;         // リーフ: 自値 / 親: 02-engine §2.3 の加重平均（丸めない実数）
}
interface DerivedIndex {
  byId: Map<string, DerivedTask>;  // key = idKey
  order: string[];                 // 表示順の全タスク id（折りたたみ無視）
  rootIds: string[];
}
```

---

## 5. 書き出し

### 5.1 パイプライン

```
[TS] engine/document.ts: prepareForSave(doc) → doc'   （§5.2）
[Rust] save_file(path, doc')
  1. serde で GanttDocument にデシリアライズ（これにより構造体定義順＝スキーマ順にキーが並ぶ）
  2. 防御的に、親タスク（parentId で参照される id）の start/end/progress/hours を None にする
  3. JSON Schema 検証。違反なら保存せず SCHEMA_INVALID を返す（実装バグの検出用）
  4. serde_json::to_string_pretty（インデント 2 スペース）+ 末尾 "\n"
  5. 同じディレクトリの一時ファイル（`.<name>.json-gantt.tmp`）に書き、fsync、rename で置換（原子的保存）
  6. 書いた内容の SHA-256 を watcher に通知（自分の保存を外部変更と誤検知しない。04-backend §5）
```

### 5.2 書き出しルール

| ルール | 内容 |
|---|---|
| キー順 | §2 の表の順。未知キーは各オブジェクトの末尾に、読み込み時の順序で |
| 導出値 | 親タスクの `start/end/progress/hours` は書かない |
| 常に書くキー | `version, project, resources, colorLabels, tasks, view`、Task の `id, parentId, name, resourceIds, dependencies`、リーフの `start, end, progress` |
| 無ければ書かないキー | `$schema, project.description, project.calendar, Resource.color, Task.hours, Task.colorLabelId, Task.notes, Dependency.lag` |
| タスク順 | 表示順（深さ優先前順） |
| `view.collapsedTaskIds` | 存在する親タスク id のみに絞り、表示順に並べる |
| `calendar.holidays` | 昇順ソート、重複除去 |
| 数値 | `hours` は読み込んだ数値表現を保つ（Rust では `serde_json::Number`。`8` は `8`、`8.5` は `8.5`）。`progress` は整数 |
| 書式 | UTF-8（BOM なし）、インデント 2、改行 LF、末尾改行 1 つ。非 ASCII はエスケープしない |
| 未知フィールド | トップレベル・Project・Calendar・Resource・ColorLabel・Task・Dependency・ViewSettings のすべてで保持 |

`prepareForSave` は TS 側で上表の「タスク順」「collapsedTaskIds」「holidays」「空文字の description/notes 削除」を行う。キー順と数値表現は Rust が担う。

### 5.3 ラウンドトリップ保証

テスト（cargo test）: `schema/examples/sample.json` を open → save した結果がバイト一致すること。未知フィールドを各階層に 1 つずつ足したフィクスチャでもバイト一致すること。

保証の範囲外（既知の正規化）: 未知フィールドを含む数値は `serde_json` の標準表現に正規化される（`1e2` → `100.0`、`1.50` → `1.5`、2^53 を超える整数や極端に長い小数は精度が落ちる）。`arbitrary_precision` は使わない（既知フィールドの `hours` は `serde_json::Number` で保持するため `8` は `8` のまま）。文字列のエスケープ表現（`\u00e9` → `é` 等）も正規化される。

---

## 6. バージョン移行方針

- `version` は整数。現行 `1`。スキーマは `const: 1`。
- Rust `open_file` はスキーマ検証の**前に** `version` を読む:
  - 欠損または整数でない → `SCHEMA_INVALID`（`/version` required/type エラーとして）
  - `> CURRENT_VERSION` → `UNSUPPORTED_VERSION { found, supported }`（「新しいバージョンのアプリで作成されたファイルです」）
  - `< CURRENT_VERSION` → `src-tauri/src/migrate.rs` の移行関数 `migrate_v{n}_to_v{n+1}(Value) -> Result<Value>` を順に適用し、warning `MIGRATED { from, to }` を返す（保存すると新版で書かれる。保存前に dirty にはしない）
- スキーマの破壊的変更時は: `version` を +1、`const` を更新、移行関数を追加、移行テスト（旧版フィクスチャ → 新版で検証通過）を追加。ARCHITECTURE の 3 か所同期（スキーマ → TS 型 → Rust モデル）に加えて移行関数も同時に更新する。
- 後方互換な追加（任意フィールドの追加）は `version` を上げない。旧アプリでも未知フィールドとして保持される。

---

## 7. TS 型と生成

- `pnpm gen:types` → `src/model/schema.d.ts`（json-schema-to-typescript。WP0 の package.json の設定に従う）。生成物はコミットし、手で編集しない。
- `src/model/types.ts` で生成型を再エクスポートし、アプリ内で使う補助型を定義する:

```ts
export type { GanttDocument, Task, Resource, ColorLabel, Dependency, Project, Calendar, ViewSettings } from "./schema";
export type IsoDate = string;          // "YYYY-MM-DD"
export type Zoom = "day" | "week" | "month";
```

- `src/model/date.ts`: 日付ユーティリティ（UTC の epoch day で計算し、`Date` のローカルタイムゾーンを使わない）
  - `toEpochDay(d: IsoDate): number`（1970-01-01 = 0）
  - `fromEpochDay(n: number): IsoDate`
  - `addDays(d, n): IsoDate`、`diffDays(a, b): number`（b - a）、`dayOfWeek(d): 0..6`（0=日）
  - `isValidIsoDate(s): boolean`、`todayIso(): IsoDate`（ローカル日付。UI 層からのみ呼ぶ。エンジンには引数で渡す）
- `src/model/id.ts`: `newId(): string`（`crypto.randomUUID()`、小文字）、`idKey(id)`。

## 8. サンプル

`schema/examples/sample.json`: 「A Project Plan」配下に 5 フェーズ × 5 子 = 31 タスク、2023-05-22（月）〜2023-06-02（金）、`calendar.weekends = [0, 6]`、リソース Vic/Emma/Benjamin/Ava/William、色ラベル General/Important/Label3。全 FS 制約を満たす（I12 違反なし）。エンジン・UI・PDF のテストフィクスチャとしても使う。
