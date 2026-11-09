# 02. エンジン詳細設計（`src/engine/`）

前提: `docs/ARCHITECTURE.md`、`01-data-model.md`。
エンジンは**副作用なし**。入力はドキュメント（+ 操作引数 + コンテキスト）、出力は新しいドキュメントと immer patches。UI・Tauri・`Date.now()`・乱数に依存しない（今日の日付と ID 生成は `CommandContext` で注入する）。

ファイル構成:

| ファイル | 内容 |
|---|---|
| `src/engine/calendar.ts` | 稼働日計算、期間フォーマット/パース（§1） |
| `src/engine/hierarchy.ts` | 木構造の参照、導出値、構造変更（§2） |
| `src/engine/scheduling.ts` | FS 制約、自動スケジューリング、循環検出（§3） |
| `src/engine/commands.ts` | ユーザー操作 → 状態変更（§4） |
| `src/engine/document.ts` | 読み込み時の意味検証・正規化、保存前処理（01-data-model §4, §5）。ARCHITECTURE の engine 一覧に無いファイルだが、同じ「純粋関数」原則の範囲内での追加 |
| `src/engine/errors.ts` | エラーコード定義 |
| `src/engine/index.ts` | 公開 API の再エクスポート |
| `src/engine/__tests__/*.test.ts` | vitest |

共通の型:

```ts
import type { GanttDocument, Task, IsoDate } from "../model/types";
// 日付演算はすべて src/model/date.ts（UTC epoch day）を使う
```

---

## 1. calendar.ts

### 1.1 型

```ts
export interface WorkCalendar {
  readonly enabled: boolean;            // project.calendar が存在するか
  readonly weekends: ReadonlySet<number>; // 0..6
  readonly holidays: ReadonlySet<IsoDate>;
  readonly daysPerWeek: number;         // 期間表示の 1w の日数（§1.4）
}
export function compileCalendar(cal: Calendar | undefined): WorkCalendar;
```

`compileCalendar(undefined)` → `{ enabled: false, weekends: ∅, holidays: ∅, daysPerWeek: 7 }`。
`compileCalendar({ weekends, holidays })` → `{ enabled: true, ..., daysPerWeek: 7 - weekends.length }`（`[0,6]` なら 5）。

ストアは `doc.project.calendar` が変わったときだけ再コンパイルする（セレクタでメモ化）。

### 1.2 関数

| 関数 | 仕様 |
|---|---|
| `isWorkingDay(d, wc): boolean` | `!wc.enabled` なら常に true。そうでなければ `!weekends.has(dayOfWeek(d)) && !holidays.has(d)` |
| `nextWorkingDay(d, wc): IsoDate` | d が稼働日なら d、そうでなければ d より後の最初の稼働日 |
| `prevWorkingDay(d, wc): IsoDate` | d が稼働日なら d、そうでなければ d より前の最後の稼働日 |
| `addWorkingDays(d, n, wc): IsoDate` | n = 0 → d（d が非稼働日でもそのまま）。n > 0 → d より**後**の n 番目の稼働日（d 自身は数えない）。n < 0 → d より**前**の \|n\| 番目の稼働日 |
| `workingDaysBetween(a, b, wc): number` | `[a, b]`（両端包含）に含まれる稼働日数。b < a なら 0 |
| `workingDayOffset(a, b, wc): number` | b > a なら `(a, b]` の稼働日数、b < a なら `-([b, a) の稼働日数)`、等しければ 0。a, b が稼働日なら `addWorkingDays(a, k) === b` が成り立つ |
| `durationOf(start, end, wc): number` | `workingDaysBetween(start, end, wc)`（タスクの期間） |

安全装置: ループで日を進める関数は 1 回の呼び出しで 3660 日（約 10 年）を超えて進んだら `CalendarError("CALENDAR_NO_WORKING_DAY")` を投げる（`weekends` は最大 6 個なので通常は起きないが、祝日が大量に連続する入力への防御）。`workingDaysBetween` は `diffDays` に比例する単純ループでよい（タスク期間は数百日規模を想定）。

### 1.3 稼働日への揃え（スナップ）方針

エンジンのコマンドが日付を**生成**するときは、結果の `start` / `end` を稼働日に揃える（カレンダー無効時は何もしない）。

| 場面 | 揃え方 |
|---|---|
| 移動（正方向）・後続の押し出し・開始日のリサイズ | `nextWorkingDay` |
| 移動（負方向）・終了日のリサイズ | `prevWorkingDay`（移動の場合は start に適用し end は期間から再計算） |
| 期間保持での end 再計算 | `end = addWorkingDays(start, d - 1)`, `d = max(1, durationOf(旧 start, 旧 end))` |

右パネルでの日付直接入力（`setDates`）は**揃えない**（ユーザーが明示した値を尊重）。

### 1.4 期間フォーマット / パース

```ts
export function formatDuration(days: number, wc: WorkCalendar): string;
export function parseDuration(text: string, wc: WorkCalendar): number | null;
```

- `W = wc.daysPerWeek`（カレンダー無効: 7、`weekends=[0,6]`: 5）。
- `formatDuration`: `days <= 0` → `"0d"`。`w = floor(days / W)`, `r = days % W`。`w == 0` → `"${r}d"`、`r == 0` → `"${w}w"`、それ以外 → `"${w}w${r}d"`。
- `parseDuration`: 前後空白除去・小文字化した文字列に `/^(?:(\d+)\s*w)?\s*(?:(\d+)\s*d?)?$/` を適用。両グループとも無い・合計 0 → `null`。`w * W + d` を返す。例: `"1w2d"`, `"1W 2D"`, `"3"`, `"2w"`。

> 指示では「1w=5稼働日」。`weekends=[0,6]`（標準）では 5 になる。週末が 2 日以外のカレンダーでは `7 - weekends.length` とした（1 週間の稼働日数の自然な一般化）。

---

## 2. hierarchy.ts

### 2.1 参照系

すべて O(n) 以下。`TreeIndex` を 1 回作って使い回す。

```ts
export interface TreeIndex {
  byId: Map<string, Task>;               // key = idKey(id)
  childrenOf: Map<string | null, string[]>; // null = ルート。値は配列内の相対順
  parentOf: Map<string, string | null>;
}
export function buildTreeIndex(doc: GanttDocument): TreeIndex;
export function getChildren(ix, id: string | null): string[];
export function isParent(ix, id): boolean;          // childrenOf.get(id)?.length > 0
export function getDepth(ix, id): number;           // ルート = 0
export function getAncestors(ix, id): string[];     // 近い順（親, 祖父, ...）
export function getDescendants(ix, id): string[];   // 前順、自分は含まない
export function getLeafDescendantsOrSelf(ix, id): string[]; // リーフなら [id]
export function getSubtreeRange(doc, ix, id): [number, number]; // 配列内の [開始 index, 終了 index)（前順なので連続）
export function displayOrder(ix): string[];         // 前順の全 id
export function visibleRows(ix, collapsed: ReadonlySet<string>): string[]; // 折りたたまれた祖先を持つ行を除く
export function previousSibling(ix, id): string | null;
export function nextSibling(ix, id): string | null;
```

前提: ドキュメントの `tasks` は常に前順（01-data-model §4.2 で正規化、以後全コマンドが維持）。

### 2.2 導出（`deriveAll(doc, wc): DerivedIndex`、型は 01-data-model §4.3）

後順（子 → 親）で計算する。

| 値 | リーフ | 親 |
|---|---|---|
| `start` | `task.start` | `min(子.start)`（導出済みの子を使う） |
| `end` | `task.end` | `max(子.end)` |
| `durationDays` | `durationOf(start, end)` | `durationOf(導出 start, 導出 end)` |
| `hours` | `task.hours`（undefined 可） | `Σ 子.hours`（undefined は 0 として加算）。全子が undefined なら undefined |
| `progress` | `task.progress ?? 0` | §2.3 |

### 2.3 親の進捗（`weightedProgress(children: DerivedTask[]): number`）

1. 全ての直接の子で `hours !== undefined` かつ `Σ hours > 0` → **工数加重**: `Σ(hours_i × progress_i) / Σ hours_i`
2. それ以外 → **日数加重**: `w_i = durationDays_i`。`Σ w_i > 0` なら `Σ(w_i × progress_i) / Σ w_i`
3. それも 0（全子が非稼働日だけのタスク）→ 単純平均

丸めない（実数）。表示側で丸める（バー/表: 整数に `Math.round`、ステータスバー: 小数 2 桁）。
プロジェクト全体の進捗（ステータスバー）は、ルートタスク群を子とみなして同じ関数で計算する。タスク 0 件なら 0。

### 2.4 構造変更（純粋関数。`commands.ts` から draft に対して呼ぶ）

すべて「draft（immer）を受けて変更する」内部関数として実装し、公開はコマンド経由とする。

#### indent(id)

- 前提: `prev = previousSibling(id)` が存在。無ければ `NO_PREVIOUS_SIBLING`。
- 結果: `task.parentId = prev.id`。task は prev の**最後の子**になる。前順では prev の部分木が task の直前に連続しているため、**配列の並びは変わらない**。
- prev がリーフだった場合: prev は親になる。prev の `start/end/progress/hours` は**削除**（以後は導出値）。
- 検証: 変更後に I6（祖先-子孫間の依存）・I7（S/E グラフの循環）を検査し、違反なら変更せず `DEPENDENCY_CONFLICT`。
  - 典型: A→B の FS 依存があるとき B をインデントして A の子にしようとすると拒否される。
- `reveal: [id]`（ストアが prev を展開する。§4.5）

#### outdent(id)

- 前提: `task.parentId !== null`。無ければ `NOT_INDENTED`。
- `P = parent(task)`。結果: `task.parentId = P.parentId`。task の部分木ブロックを配列から取り出し、**P の部分木の直後**に挿入。task より後ろの兄弟は P の子のまま（task の子にはならない）。
- P の子が 0 になった場合: P はリーフになり、**操作前の P の導出値**を固定値として書く: `start, end, progress = Math.round(導出 progress)`, `hours`（導出が undefined なら書かない）。
- 検証: I6・I7（理論上違反しないが、共通検査を通す）。

#### moveUp(id) / moveDown(id)

- 前提: `previousSibling(id)`（moveUp）/ `nextSibling(id)`（moveDown）が存在。無ければ `NO_PREVIOUS_SIBLING` / `NO_NEXT_SIBLING`。
- 結果: 自分の部分木ブロックと相手の部分木ブロックを配列内で入れ替える。親は変わらない（親をまたいだ移動はしない）。
- 日付は変わらない。

#### deleteTasks(ids)

- 前提: 全 id が存在。
- 結果: 各 id とその子孫をすべて削除。残るタスクの `dependencies` から、削除されたタスクを `predecessorId` とする要素を削除。
- 削除により子が 0 になった親は、outdent と同様に**操作前の導出値**を固定値として書いてリーフにする。
- `view.collapsedTaskIds` は触らない（存在しない id は表示時に無視、保存時に除外。01-data-model I11）。

#### 折りたたみ（ビュー操作）

`toggleCollapsed(view, id)`, `setCollapsed(view, id, bool)`, `expandAll(view)`, `collapseAll(view, ix)`（全ての親 id）、`revealTask(view, ix, id)`（全祖先を collapsed から外す）。これらは `ViewSettings` を受けて新しい `ViewSettings` を返す。**Undo 対象外**（04 節・store の設計参照）。リーフ id を collapsed に入れても無視される。

---

## 3. scheduling.ts

### 3.1 FS 制約

依存 `dep`（後続タスク `s` の `dependencies[]` の要素、先行 `p = dep.predecessorId`）について:

```
earliestFrom(p, dep) = nextWorkingDay(addDays(end(p), 1 + (dep.lag ?? 0)))
満たす条件: start(s) >= earliestFrom(p, dep)
```

`start(x)` / `end(x)` は、x がリーフなら自値、親なら導出値（その時点の draft から子孫リーフの min/max を計算）。

```ts
export function earliestStartFor(doc, ix, wc, taskId): IsoDate | null
```
= taskId **およびその全祖先**を後続とする全依存の `earliestFrom` の最大値。無ければ null。
（親に入っている依存は、その子孫すべての開始の下限になる）

### 3.2 押し出しの基本操作

```
shiftLeafTo(leaf, target):
  d = max(1, durationOf(leaf.start, leaf.end))
  s = nextWorkingDay(target)
  leaf.start = s; leaf.end = addWorkingDays(s, d - 1)

shiftGroupTo(parent, target):          // 親を後続にした依存の押し出し
  ps = nextWorkingDay(start(parent))
  k  = workingDayOffset(ps, nextWorkingDay(target))     // > 0
  for leaf in leafDescendants(parent):
     shiftLeafTo(leaf, addWorkingDays(nextWorkingDay(leaf.start), k))
  // 子全体を k 稼働日ずらす（相対配置・各期間を保つ）。最も早い子の start がちょうど target になる

pushIfViolated(succId, earliest) -> movedLeafIds[]:
  if start(succ) >= earliest: return []
  succ がリーフ → shiftLeafTo(succ, earliest); return [succId]
  succ が親     → shiftGroupTo(succ, earliest); return leafDescendants(succ)
```

### 3.3 伝播（`schedule`）

```ts
export function schedule(draft: GanttDocument, wc: WorkCalendar,
                         seeds: string[] /* リーフ id */, opts: { clampSeeds: boolean }): void
```

```
ix = buildTreeIndex(draft)
outgoing = Map<predId, Array<{ succId, dep }>>   // 全依存から作る
if opts.clampSeeds:
  for L in seeds:                          // ルール B: 操作されたタスク自身を制約に合わせる
    es = earliestStartFor(L)
    if es && L.start < es: shiftLeafTo(L, es)
queue = [...seeds]（重複なし）; LIMIT = 50 × (タスク数 + 依存数 + 1); steps = 0
while queue 非空:
  if ++steps > LIMIT: throw SchedulingError("SCHEDULING_DIVERGED")
  L = queue.shift()
  for N in [L, ...getAncestors(L)]:        // ルール A: L と、L によって導出値が変わり得る祖先から後続へ
    for { succId, dep } in outgoing.get(N):
      moved = pushIfViolated(succId, earliestFrom(N, dep))
      for m in moved: if m ∉ queue: queue.push(m)
```

性質:
- **後ろにしか動かさない**（前方向に詰めない。ARCHITECTURE 原則）。先行が前に動いても後続は動かない。
- 期間（稼働日数）を保つ。推移的に伝播する。
- 伝播の起点はコマンドが変更したリーフだけ。読み込み時から存在する、今回の操作と無関係な制約違反は直さない（§3.6）。
- 親が後続の依存は「子全体を同じ稼働日数だけずらす」（`shiftGroupTo`）。親が先行の依存は「親の導出 end」を使う。
- ルール B（`clampSeeds`）により、ユーザーが後続タスクを先行の終了より前へ動かすと、先行の制約位置で止まる（ドラッグのプレビューでもその位置で止まって見える）。ルール B は seed のリーフ単位で適用する（親を後続とする依存による制約でも、そのリーフだけを動かす。グループ移動はしない）。

### 3.4 循環検出（S/E グラフ）

親子と依存の両方を考慮するため、タスク t ごとに 2 ノード `S(t)`（開始）`E(t)`（終了）を持つ有向グラフを使う。

| 関係 | 辺 |
|---|---|
| リーフ t | `S(t) → E(t)` |
| 親 P とその子 c | `S(P) → S(c)`（親を押すと子が動く）、`E(c) → E(P)`（子の終了が親の終了を決める） |
| 依存（先行 p → 後続 s） | `E(p) → S(s)` |

このグラフに閉路があれば、制約を満たす配置が存在しない（または伝播が終わらない）。例:
- 子が親に依存（P → c）: `E(P) → S(c) → E(c) → E(P)` 閉路
- 親が子に依存（c → P）: `E(c) → S(P) → S(c) → E(c)` 閉路
- A → B、B → C、C が A の子: `E(A) → S(B) → E(B) → S(C) → E(C) → E(A)` 閉路

```ts
export function findDependencyCycle(doc): string[] | null;  // 閉路上のタスク id（重複除去、出現順）。無ければ null
export function canAddDependency(doc, succId, predId):
  { ok: true } | { ok: false; code: "TASK_NOT_FOUND" | "DEPENDENCY_SELF" | "DEPENDENCY_DUPLICATE" | "DEPENDENCY_ANCESTOR" | "DEPENDENCY_CYCLE" };
export function validateStructure(doc): { code; taskIds }[];  // I6 と I7 を検査（indent 等の後と読み込み時に使用）
```

- DFS は再帰でなく明示スタックで実装する（深い依存チェーンでのスタックオーバーフロー防止）。3 色（白/灰/黒）で後退辺を検出。
- `canAddDependency` の判定順: 存在 → 自己 → 重複 → 祖先/子孫（`getAncestors` で判定。I6 は S/E 閉路にも含まれるが、メッセージを分けるため先に判定）→ 辺 `E(pred) → S(succ)` を追加したグラフで、`S(succ)` から `E(pred)` に到達できるか（到達できれば `DEPENDENCY_CYCLE`）。

### 3.5 全体再スケジュール

```ts
export function rescheduleAll(draft, wc): void
```
全依存について `pushIfViolated` を、変化がなくなるまで繰り返す（反復上限 `LIMIT` は §3.3 と同じ式、超えたら `SCHEDULING_DIVERGED`）。ユーザーがステータスバーの「依存違反 n 件」から明示的に実行する（§4 `rescheduleAll` コマンド）。

### 3.6 違反の列挙

```ts
export interface Violation { succId: string; predId: string; earliest: IsoDate; actualStart: IsoDate }
export function findViolations(doc, wc): Violation[];
```

読み込み時（警告 `DEPENDENCY_VIOLATION`）、ステータスバー表示、矢印の赤表示に使う。カレンダー変更（`setCalendar`）後も自動では直さない（違反として表示される）。

---

## 4. commands.ts

### 4.1 インターフェース

```ts
import { produceWithPatches, enablePatches, type Patch } from "immer";
enablePatches(); // モジュール初期化時に 1 回

export interface CommandContext {
  today: IsoDate;               // UI 層が todayIso() で渡す
  newId: () => string;          // UI 層は model/id.ts の newId、テストは連番
  defaultTaskName: string;      // i18n の "task.defaultName"
}
export type Command =
  | { type: "moveTask"; id: string; deltaDays: number }
  | { type: "resizeTaskEnd"; id: string; newEnd: IsoDate }
  | { type: "resizeTaskStart"; id: string; newStart: IsoDate }
  | { type: "setDates"; id: string; start: IsoDate; end: IsoDate }
  | { type: "setDuration"; id: string; days: number }
  | { type: "setProgress"; id: string; progress: number }
  | { type: "setHours"; id: string; hours: number | null }
  | { type: "setName"; id: string; name: string }
  | { type: "setNotes"; id: string; notes: string }
  | { type: "addTask"; afterId: string | null }
  | { type: "duplicateTask"; id: string }
  | { type: "deleteTask"; id: string }
  | { type: "indent"; id: string }
  | { type: "outdent"; id: string }
  | { type: "moveUp"; id: string }
  | { type: "moveDown"; id: string }
  | { type: "setResources"; id: string; resourceIds: string[] }
  | { type: "setColorLabel"; id: string; colorLabelId: string | null }
  | { type: "addDependency"; succId: string; predId: string; lag?: number }
  | { type: "removeDependency"; succId: string; predId: string }
  | { type: "setDependencyLag"; succId: string; predId: string; lag: number }
  | { type: "rescheduleAll" }
  | { type: "setProjectInfo"; name?: string; description?: string }
  | { type: "setCalendar"; calendar: Calendar | null }
  | { type: "addResource"; name: string; color?: string }
  | { type: "updateResource"; id: string; name?: string; color?: string | null }
  | { type: "deleteResource"; id: string }
  | { type: "addColorLabel"; name: string; color: string }
  | { type: "updateColorLabel"; id: string; name?: string; color?: string }
  | { type: "deleteColorLabel"; id: string };

export interface CommandOk {
  ok: true;
  doc: GanttDocument;
  patches: Patch[];          // 空なら変更なし（ストアは Undo に積まない・dirty にしない）
  inversePatches: Patch[];
  selection?: string | null; // 指定時、ストアは選択をこの id にする（null は選択解除）
  editName?: boolean;        // true ならストアは selection の名前をインライン編集状態にする
  reveal?: string[];         // ストアはこれらの祖先を展開する（view 操作、Undo 対象外）
  createdId?: string;        // addResource / addColorLabel / addTask で生成した id
}
export interface CommandErr { ok: false; code: EngineErrorCode; params?: Record<string, string | number> }
export function executeCommand(doc: GanttDocument, cmd: Command, ctx: CommandContext): CommandOk | CommandErr;
```

実装: `produceWithPatches(doc, draft => { ... })` の中で前提条件を検査し、満たさなければ例外 `CommandRejected(code, params)` を投げて `executeCommand` が `CommandErr` に変換する（draft は破棄される）。WorkCalendar は `compileCalendar(draft.project.calendar)` で都度作る（純粋性のため。コストは小さい）。

コマンドは `doc.view` を**変更しない**（view は Undo 対象外のため。§4.5）。

### 4.2 共通の前提条件エラー

| コード | 条件 |
|---|---|
| `TASK_NOT_FOUND` | 指定 id のタスクが無い |
| `PARENT_NOT_EDITABLE` | 親タスクに対して日付・期間・進捗・工数を設定しようとした |
| `START_AFTER_END` | `setDates` で start > end |
| `INVALID_VALUE` | 数値が範囲外・NaN、日付文字列が不正、`setDuration` の days < 1 |

### 4.3 コマンド仕様

表の「自動スケジュール」は §3.3 の `schedule` 呼び出し（seeds / clampSeeds）。

| コマンド | 前提条件 | 結果 | 自動スケジュール |
|---|---|---|---|
| `moveTask(id, deltaDays)` | id 存在。`deltaDays` は整数（0 なら変更なし） | **リーフ**: `t = addDays(start, Δ)`; Δ>0 なら `nextWorkingDay(t)`、Δ<0 なら `prevWorkingDay(t)` を新 start とし、期間保持で end 再計算。**親**: `ps = nextWorkingDay(導出 start)`, `target = 同じスナップ規則(addDays(導出 start, Δ))`; `es = earliestStartFor(親)` があり `target < es` なら `target = nextWorkingDay(es)`; `k = workingDayOffset(ps, target)`; 全子孫リーフを `shiftLeafTo(leaf, addWorkingDays(nextWorkingDay(leaf.start), k))` | seeds = 動いた全リーフ、clamp = true |
| `resizeTaskEnd(id, newEnd)` | リーフ | `e = prevWorkingDay(newEnd)`; `e < start` なら `e = start`; `end = e` | seeds = [id], clamp = false |
| `resizeTaskStart(id, newStart)` | リーフ | `s = nextWorkingDay(newStart)`; `es = earliestStartFor(id)` があり `s < es` なら `s = es`; `s > end` なら `end = s`; `start = s` | seeds = [id], clamp = false |
| `setDates(id, start, end)` | リーフ、start ≤ end | そのまま設定（スナップしない） | seeds = [id], clamp = true（先行より前なら期間保持で後ろへ移る） |
| `setDuration(id, days)` | リーフ、整数 days ≥ 1 | start が稼働日なら `end = addWorkingDays(start, days-1)`、非稼働日なら `end = addWorkingDays(start, days)` | seeds = [id], clamp = false |
| `setProgress(id, p)` | リーフ、0 ≤ p ≤ 100 | `progress = Math.round(p)` | なし |
| `setHours(id, h)` | リーフ、h は null または ≥ 0 | null なら `hours` キー削除、それ以外は設定 | なし |
| `setName(id, name)` | id 存在 | `name` を設定（前後空白は除去しない） | なし |
| `setNotes(id, notes)` | id 存在 | 空文字ならキー削除、それ以外は設定 | なし |
| `addTask(afterId)` | afterId が null または存在 | 新タスク `{ id: ctx.newId(), parentId, name: ctx.defaultTaskName, start, end, progress: 0, resourceIds, dependencies: [] }`。**afterId あり**: `parentId = after.parentId`、配列上 after の部分木の直後に挿入、after がリーフなら `start/end = after の start/end`、親なら `start = end = after の導出 start`。**afterId = null**: ルートの末尾（配列末尾）に追加、`start = end = nextWorkingDay(ctx.today)`。`resourceIds` は新しい親の `resourceIds` のコピー（ルートなら `[]`） | seeds = [新 id], clamp = true。`selection = 新 id, editName = true, reveal = [新 id], createdId` |
| `duplicateTask(id)` | id 存在 | 部分木を複製（新 id を前順で `ctx.newId()` から割り当て）、元の部分木の直後に挿入、同じ parentId。部分木内部の依存は新 id に張り替え、部分木外を先行とする依存はそのままコピー。部分木外から元タスクへの依存は複製しない。名前は同じ | seeds = 複製のリーフ, clamp = true。`selection = 複製のルート id` |
| `deleteTask(id)` | id 存在 | §2.4 deleteTasks([id])。`selection` = 削除前の表示行で次の行（同じ部分木外の最初の可視行）、無ければ前の行、無ければ null | なし（削除は制約を緩めるだけ。子を失った親は導出値をそのまま固定するので日付は変わらない） |
| `indent(id)` | §2.4 | §2.4 | seeds = id の全リーフ（id がリーフなら [id]）, clamp = true。`reveal = [id]` |
| `outdent(id)` | §2.4 | §2.4 | seeds = id の全リーフ ＋（旧親がリーフ化したら旧親）, clamp = true |
| `moveUp(id)` / `moveDown(id)` | §2.4 | §2.4 | なし |
| `setResources(id, ids)` | 全 id が `resources` に存在（`INVALID_VALUE`）、重複除去 | task の `resourceIds = ids`。task が親なら**全子孫**の `resourceIds` も同じ配列（コピー）に置換 | なし |
| `setColorLabel(id, labelId)` | labelId は null または存在 | null ならキー削除、それ以外は設定。伝播しない | なし |
| `addDependency(succId, predId, lag?)` | `canAddDependency` が ok | `succ.dependencies.push({ predecessorId: predId, ...(lag ? { lag } : {}) })`。直後に `moved = pushIfViolated(succId, earliestFrom(predId, dep))` | seeds = moved, clamp = false |
| `removeDependency(succId, predId)` | 該当依存が存在（無ければ `DEPENDENCY_NOT_FOUND`） | 削除 | なし |
| `setDependencyLag(succId, predId, lag)` | 整数（`INVALID_VALUE`）、該当依存が存在（無ければ `DEPENDENCY_NOT_FOUND`） | `lag` を更新（0 なら項目を削除）。同値なら変更なし（patches 空）。変更時は直後に `moved = pushIfViolated(succId, earliestFrom(predId, dep))`。ラグを減らしても後続は前倒ししない | seeds = moved, clamp = false |
| `rescheduleAll` | — | §3.5 | （自身が全体再計算） |
| `setProjectInfo` | — | 指定キーのみ更新。description が空文字ならキー削除 | なし |
| `setCalendar(cal)` | weekends は 0..6 の整数で 6 個以下、holidays は有効な日付 | null なら `project.calendar` 削除。holidays は昇順・重複除去 | なし（違反は §3.6 で表示） |
| `addResource(name, color?)` | — | `{ id: ctx.newId(), name, color? }` を末尾に追加 | なし。`createdId` |
| `updateResource(id, ...)` | 存在 | name/color を更新（color: null はキー削除） | なし |
| `deleteResource(id)` | 存在 | resources から削除し、全タスクの `resourceIds` から除去 | なし |
| `addColorLabel` / `updateColorLabel` | — | resource と同様 | なし |
| `deleteColorLabel(id)` | 存在 | colorLabels から削除し、該当 `colorLabelId` を持つ全タスクからキー削除 | なし |

### 4.4 ドラッグとの関係

ドラッグ中のプレビューは「ドラッグ開始時のドキュメント」に対して毎回 `executeCommand` を実行した結果を表示し、ストアには確定しない。pointerup で同じコマンドを 1 回だけ確定する（= 1 Undo 単位。03-ui §6）。したがってコマンドは冪等である必要はないが、**同じ入力に対して同じ出力**（純粋）でなければならない。

### 4.5 Undo / view との関係（ストア側の約束。WP4 で実装）

- Undo スタックの要素 = `{ patches, inversePatches, label: Command["type"] }`。上限 200。新しいコマンド確定で redo スタックは破棄。
- `doc.view`（zoom / collapsedTaskIds）の変更は**Undo に積まない**。ストアの別アクション（`setZoom`, `toggleCollapsed` 等）で `immer.produce` により直接変更し、`viewDirty = true` にする。エンジンのコマンドは view に触れないので、パッチのパスが衝突しない。
- dirty = `undoスタックの現在位置 id !== 保存時の位置 id || viewDirty`。

---

## 5. document.ts

```ts
export interface LoadIssue { code: string; path: string; params?: Record<string, string | number> } // path は JSON Pointer
export function loadDocument(raw: GanttDocument): { ok: true; doc: GanttDocument; warnings: LoadIssue[] } | { ok: false; errors: LoadIssue[] };
export function prepareForSave(doc: GanttDocument): GanttDocument;
export function createEmptyDocument(ctx: { projectName: string }): GanttDocument;
// → { version: 1, project: { name }, resources: [], colorLabels: [], tasks: [], view: { zoom: "day", collapsedTaskIds: [] } }
```

`loadDocument` は 01-data-model §3 の検証（エラーは全件収集してから返す）→ §4.2 の正規化 → 警告収集（I9, I10, I12）。エラーコードと path の例:

| code | path 例 |
|---|---|
| `DUPLICATE_ID` | `/tasks/4/id` |
| `PARENT_NOT_FOUND` | `/tasks/7/parentId` |
| `PARENT_CYCLE` | `/tasks/2/parentId`（閉路上の各タスク） |
| `DEPENDENCY_NOT_FOUND` / `DEPENDENCY_SELF` / `DEPENDENCY_DUPLICATE` | `/tasks/9/dependencies/0/predecessorId` |
| `DEPENDENCY_ANCESTOR` / `DEPENDENCY_CYCLE` | `/tasks/9/dependencies/0` |
| `LEAF_NO_DATES` | `/tasks/3` |
| `START_AFTER_END` | `/tasks/3/end` |

閉路検査（PARENT_CYCLE）が失敗した場合は、木構造が組めないので以降の検査（依存・日付）は行わずにエラーを返す。

---

## 6. エラーコード一覧（`errors.ts`）

```ts
export type EngineErrorCode =
  | "TASK_NOT_FOUND" | "PARENT_NOT_EDITABLE" | "START_AFTER_END" | "INVALID_VALUE"
  | "NO_PREVIOUS_SIBLING" | "NO_NEXT_SIBLING" | "NOT_INDENTED" | "DEPENDENCY_CONFLICT"
  | "DEPENDENCY_SELF" | "DEPENDENCY_DUPLICATE" | "DEPENDENCY_ANCESTOR" | "DEPENDENCY_CYCLE" | "DEPENDENCY_NOT_FOUND"
  | "SCHEDULING_DIVERGED" | "CALENDAR_NO_WORKING_DAY";
```
UI はコード → i18n キー `error.engine.<CODE>` でトースト表示する（03-ui §12）。

---

## 7. テストケース（vitest）

共通フィクスチャ（`src/engine/__tests__/fixtures.ts`）:
- `WC5 = compileCalendar({ weekends: [0, 6], holidays: [] })`、`WC0 = compileCalendar(undefined)`
- 2023-05-22 は月曜。05-26 金、05-27 土、05-28 日、05-29 月。
- `doc(tasks)` ヘルパ: `version:1, project:{name:"T", calendar:{weekends:[0,6],holidays:[]}}` を持つドキュメントを作る。id は `"A"`, `"B"` 等の短い文字列でよい（エンジンは UUID 形式を検査しない。形式検査はスキーマの責務）。
- `ctx = { today: "2023-05-22", newId: seq("N"), defaultTaskName: "新しいタスク" }`（`seq` は `N1`, `N2`, ... を返す）
- 依存表記 `A→B` は「B.dependencies に {predecessorId: "A"}」。

### 7.1 calendar（`calendar.test.ts`）

| # | 入力 | 期待 |
|---|---|---|
| C1 | `isWorkingDay("2023-05-27", WC5)` / `("2023-05-26", WC5)` / `("2023-05-27", WC0)` | false / true / true |
| C2 | `nextWorkingDay("2023-05-27", WC5)` / `("2023-05-26", WC5)` | `2023-05-29` / `2023-05-26` |
| C3 | `prevWorkingDay("2023-05-28", WC5)` | `2023-05-26` |
| C4 | `addWorkingDays("2023-05-25", 2, WC5)` / `("2023-05-29", -1, WC5)` / `("2023-05-27", 0, WC5)` | `2023-05-29` / `2023-05-26` / `2023-05-27` |
| C5 | `workingDaysBetween("2023-05-22","2023-06-02", WC5)` / 同 WC0 / `("2023-05-27","2023-05-28", WC5)` / `("2023-05-26","2023-05-22", WC5)` | 10 / 12 / 0 / 0 |
| C6 | holidays `["2023-05-29"]` で `nextWorkingDay("2023-05-27")` | `2023-05-30` |
| C7 | `workingDayOffset("2023-05-26","2023-05-29", WC5)` / 逆 | 1 / -1 |
| C8 | `formatDuration` WC5: 1, 5, 6, 0, 11 | `1d`, `1w`, `1w1d`, `0d`, `2w1d` |
| C9 | `formatDuration` WC0: 7, 12 | `1w`, `1w5d` |
| C10 | `parseDuration` WC5: `"1w2d"`, `" 1W 2D "`, `"3"`, `"2w"`, `"0d"`, `"abc"`, `""` | 7, 7, 3, 10, null, null, null |

### 7.2 hierarchy（`hierarchy.test.ts`）

| # | 状態 / 操作 | 期待 |
|---|---|---|
| H1 | P[A(05-22〜05-23, h8, p100), B(05-24〜05-26, h24, p0)] を derive | P: start 05-22, end 05-26, hours 32, progress 25, durationDays 5 |
| H2 | P[A(05-22〜05-23, p100, hours なし), B(05-24〜05-26, h8, p0)] | progress 40（日数加重 2:3）、hours 8 |
| H3 | G[P[A(05-22,p100)], C(05-29〜05-30,p0)] 3 階層 | P は 05-22〜05-22 p100、G は 05-22〜05-30、progress = (1×100 + 2×0)/3 = 33.33…（日数加重） |
| H4 | ルート [A, B] で `indent(B)` | B.parentId = A。A の start/end/progress/hours キーが削除。配列順 [A, B] のまま |
| H5 | ルート [A, B] で `indent(A)` | `NO_PREVIOUS_SIBLING`、doc 不変 |
| H6 | P[A, B, C] で `outdent(B)` | 配列順 P, A, C, B。B.parentId = null、C.parentId = P |
| H7 | P[A(05-22〜05-23, p100, h8)] で `outdent(A)` | P がリーフ化: P.start 05-22, end 05-23, progress 100, hours 8 |
| H8 | ルート [A, P[x, y], B] で `moveUp(B)` | 配列順 A, B, P, x, y |
| H9 | P[A, B]、X は A→X の依存を持つ。`deleteTask(P)` | P, A, B が消え、X.dependencies = [] |
| H10 | ルート [A, B]、A→B 依存あり。`indent(B)` | `DEPENDENCY_CONFLICT`、doc 不変 |
| H11 | 前順でない配列 [x(parent P), P, A] を `loadDocument` | 配列が [P, x, A] に並べ替えられる |
| H12 | 親 P が `start`/`progress` を持つファイルを `loadDocument` | キーが除去され、警告 `PARENT_DERIVED_IGNORED` |

### 7.3 scheduling（`scheduling.test.ts`）

| # | 状態 / 操作 | 期待 |
|---|---|---|
| S1 | A(05-22〜05-23) → B(05-24〜05-25)。`moveTask(A, +1)` | A 05-23〜05-24、B 05-25〜05-26 |
| S2 | A(05-24〜05-25) → B(05-26)。`resizeTaskEnd(A, "2023-05-26")` | B 05-29〜05-29（土日を飛ばす） |
| S3 | A → B → C（各 1 日、05-22, 05-23, 05-24）。`moveTask(A, +2)` | A 05-24、B 05-25、C 05-26 |
| S4 | A(05-23) → B(05-24)。`moveTask(A, -1)` | A 05-22、B は 05-24 のまま（前に詰めない） |
| S5 | A(05-23)、B(05-24) 依存なし。`addDependency(succ=B, pred=A, lag=2)` | B 05-26（`nextWorkingDay(05-23 + 3日)`）。lag=3 なら 05-29 |
| S6 | P[A(05-22〜05-23), B(05-22〜05-24)] → X(05-25)。`resizeTaskEnd(A, "2023-05-25")` | P の導出 end 05-25、X 05-26 |
| S7 | Q(05-22〜05-23) → P[A(05-24), B(05-25〜05-26)]。`moveTask(Q, +1)` | Q 05-23〜05-24、A 05-25、B 05-26〜05-29（2 稼働日を保持） |
| S8 | A(05-22〜05-23) → B(05-24)。`moveTask(B, -2)` | B は 05-24 のまま、`patches` が空 |
| S9 | A → B。`addDependency(succ=A, pred=B)` | `DEPENDENCY_CYCLE` |
| S10 | P[A]。`addDependency(succ=A, pred=P)` | `DEPENDENCY_ANCESTOR` |
| S11 | P[C]、P → B（B は P の後続）。`addDependency(succ=C, pred=B)` | `DEPENDENCY_CYCLE` |
| S12 | A(05-22〜05-24)、B(05-23〜05-23) 依存なし。`addDependency(succ=B, pred=A)` | B 05-25〜05-25 |
| S13 | 読み込み時点で違反している A(05-22〜05-25) → B(05-25〜05-26)。`resizeTaskEnd(A, "2023-05-25")`（値は同じ） | A は不変、B 05-26〜05-29（seed = A からルール A が働き、A を触ると A の後続の既存違反は直る）。patches は B の分のみ |
| S14 | WC0（カレンダー無し）で A(05-26) → B(05-27)。`moveTask(A, +1)` | A 05-27、B 05-28（土日も稼働） |
| S15 | 無関係な既存違反: C(05-22〜05-23) → D(05-22)（違反）、別に A → B。`moveTask(A, +1)` | D は 05-22 のまま（無関係な違反は直さない） |
| S16 | S15 の状態で `rescheduleAll` | D 05-24 |
| S17 | `findViolations` を S15 の初期状態に適用 | `[{ succId: "D", predId: "C", earliest: "2023-05-24", actualStart: "2023-05-22" }]` |

> 「無関係な既存違反は直さない」（S15）と「操作したタスクの後続は直す」（S13）の両方を確認する。

### 7.4 commands（`commands.test.ts`）

| # | 状態 / 操作 | 期待 |
|---|---|---|
| K1 | ルート [A(05-22〜05-23), B]、`addTask(afterId=A)` | 新タスク N1 が配列で A の直後、parentId null、05-22〜05-23、progress 0、name "新しいタスク"、`selection = N1`, `editName = true` |
| K2 | P(resourceIds [r1])[A]、`addTask(afterId=A)` | N1.parentId = P、N1.resourceIds = [r1] |
| K3 | 空ドキュメントで `addTask(null)`（today = 2023-05-27 土） | N1 05-29〜05-29 |
| K4 | P[A, Q[B]] で `setResources(P, [r1, r2])` | P, A, Q, B すべての resourceIds = [r1, r2] |
| K5 | `setProgress(P, 50)`（P は親） | `PARENT_NOT_EDITABLE` |
| K6 | P[A(05-25〜05-26), B(05-29)] で `moveTask(P, +1)` | A 05-26〜05-29、B 05-30 |
| K7 | A(05-22〜05-26, 5d) で `moveTask(A, +5)`（05-27 土 → 05-29 月） | A 05-29〜06-02 |
| K8 | A(05-29) で `moveTask(A, -1)`（05-28 日 → prev 05-26 金） | A 05-26〜05-26 |
| K9 | A(05-22) で `resizeTaskEnd(A, "2023-05-27")` | A.end = 05-26 |
| K10 | A(05-24〜05-25) で `resizeTaskStart(A, "2023-05-27")` | A.start = 05-29、A.end = 05-29 |
| K11 | A(05-22〜05-23) → B(05-24〜05-25)、`resizeTaskStart(B, "2023-05-22")` | B.start = 05-24（制約で止まる）、patches 空 |
| K12 | A(05-22) で `setDuration(A, 6)` | A.end = 05-29 |
| K13 | P[A, B] で `deleteTask(A)`、続けて `deleteTask(B)` | 2 回目で P がリーフ化し、B の日付・進捗を引き継ぐ |
| K14 | P[A, B]、A→B、外部 X → A。`duplicateTask(P)` | 複製 P', A', B'、B' の依存は A'、A' の依存は X、P' は P の部分木の直後 |
| K15 | `deleteResource(r1)` | 全タスクの resourceIds から r1 が消える |
| K16 | 任意のコマンドの `inversePatches` を `applyPatches` で適用 | 元のドキュメントと deepEqual |
| K17 | `setDates(B, "2023-05-22", "2023-05-23")`、A(05-22〜05-23) → B | B 05-24〜05-25（期間保持で後ろへ） |
| K18 | `setDates(A, "2023-05-25", "2023-05-24")` | `START_AFTER_END` |

### 7.5 document（`document.test.ts`）

| # | 入力 | 期待 |
|---|---|---|
| L1 | `schema/examples/sample.json` を `loadDocument` | ok、warnings 0 件、31 タスク、`findViolations` 0 件 |
| L2 | id 重複 | `DUPLICATE_ID`（path `/tasks/<index>/id`） |
| L3 | リーフで end 欠損 | ok、end = start |
| L4 | リーフで start/end 両方欠損 | `LEAF_NO_DATES` |
| L5 | parentId 相互参照（A.parent=B, B.parent=A） | `PARENT_CYCLE` |
| L6 | `prepareForSave`: collapsedTaskIds に存在しない id とリーフ id | 両方除外され、残りは表示順 |
| L7 | 未知フィールド（task.custom = {x:1}）を load → コマンド実行 → prepareForSave | `custom` が保持される |
