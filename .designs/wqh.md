# Design Doc: Epic wqh — perf Dolt cold-open

## 1. Overview

Cold-open Dolt-проекта на 1000+ issues в `bd_poll_data` занимает ~2.4с; измерения из epic h90:

- `op=list spawn=1678ms`
- `op=ready spawn=717ms`
- parse/transform/sync — ~484мс.

Каждый subprocess bd по факту заново поднимает embedded Dolt (`dolt sql-server` init + connection), и cost умножается на частоту poll'ов (5с active). На 1000 issues это ~24с CPU/мин.

Эпик wqh покрывает двух children:

- **ho6** — устранить сам spawn-bottleneck в Rust backend.
- **v1p** — адаптировать polling interval к размеру проекта и Dolt-факту.

Один финальный PR, sequential order: ho6 → v1p.

---

## 2. Requirements

1. Cold-open `bd_poll_data` < 1000мс на 1000 issues (Dolt backend).
2. Idle CPU время опроса снижается минимум на 50% для Dolt-проектов.
3. Работать на **любой** bd-версии (`parse_bd_version()`-gated); не-Dolt проекты (SQLite/JSONL, `br`) продолжают работать по старому пути без регрессии.
4. Graceful fallback: если выбранный fast-path недоступен — откат на текущий `execute_bd`.
5. Всё логирование — `log_*!` в Rust, `logFrontend()` в TS (никаких `console.*` / `println!`).

---

## 3. Design — Child 1 (ho6)

### 3.1 Оценка кандидатов

| # | Подход | Effort | Impact | Risk | Вердикт |
|---|--------|--------|--------|------|---------|
| 1 | **bd daemon mode** | M | High | bd 1.x не имеет документированного daemon-CLI; `supports_daemon_flag()` относится к старому 0.x-флагу `--no-daemon` и возвращает `false` для ≥0.50. Требует upstream-работы в beads. | **Отложить** (не блокировать wqh) |
| 2 | **Прямой Dolt mysql-driver в Rust** | XL | High | Дублирует bd-семантику (readiness-filter, label join, priority normalisation, status categories). Легко рассинхронизироваться c будущими bd-версиями. | **Отклонить** |
| 3 | **bd as Rust library** | XL | High | beads написан на Go (upstream `steveyegge/beads`, `cmd/`). Нет публичного Rust API. | **Отклонить (невозможно)** |
| 4 | **Unix-socket IPC** | M | Med | Нужна upstream-поддержка в bd. Отсутствует. | **Отклонить** |
| 5 | **Снизить число spawn'ов** | S | Med-High | Полностью в нашей зоне. Уже частично есть: `bd list --all`. Добавить: (a) объединить `list+ready` в один call через post-fetch readiness-filter в Rust; (b) короткая in-process memo для результатов, если mtime не изменился. | **Принять** |

### 3.2 Recommended approach

**5 + тонкий «in-process memo»-слой перед execute_bd для `bd_poll_data`**, с fallback'ом:

1. **Шаг 1 — single-spawn poll (bd ≥ 0.55 Dolt):** убрать отдельный `bd ready` call. `ready`-issues выводятся пост-factum в Rust из уже полученного `list --all` через чистую функцию `compute_ready_from(raw_open, statuses_meta)`. Criteria для readiness определены: status.category == `active` AND no non-closed blockers. Блокировщики уже есть в `BdRawIssue.dependencies`. Это устраняет `op=ready spawn=717ms` полностью.

2. **Шаг 2 — mtime-gated memo:** перед новым `list --all` spawn проверяем `get_beads_mtime()` (уже есть, lib.rs:2829). Если mtime не изменился с прошлого poll — возвращаем in-memory кэш `PollCacheEntry`, избегая spawn целиком. TTL hard cap = 60s (safety net). Memo — per-process, per-project, `LazyLock<Mutex<HashMap<String, PollCacheEntry>>>`.

3. **Fallback chain:** если `supports_list_all_flag() == false` (старый bd, `br`) или `project_uses_dolt() == false` — работает старый путь (list + ready separate, без memo, как сейчас).

### 3.3 Rust API contract

**Без новых Tauri commands.** Внешний API `bd_poll_data(cwd) -> PollData` не меняется.

Внутренние структуры (private в `lib.rs`):

```rust
struct PollCacheEntry {
    mtime: std::time::SystemTime,
    raw_open: Vec<BdRawIssue>,
    raw_closed: Vec<BdRawIssue>,
    raw_ready: Vec<BdRawIssue>,
    captured_at: std::time::Instant,
}

static POLL_MEMO: LazyLock<Mutex<HashMap<String, PollCacheEntry>>> = ...;

const POLL_MEMO_TTL_SECS: u64 = 60;

/// Pure: computes ready-set from already-fetched open issues.
/// Ready = status.category == "active" AND all blockers closed/tombstone.
fn compute_ready_from(
    open: &[BdRawIssue],
    all_known_statuses: &HashMap<String, StatusMeta>,
) -> Vec<BdRawIssue>;
```

`StatusMeta` уже есть (`useStatuses`-aligned). На Rust-side мы либо передаём статусы из `bd statuses --json` (кэшированно при первом вызове per-project), либо используем hard-coded `BUILTIN_STATUS_CATEGORIES` с той же семантикой, что `BUILTIN_FALLBACK` во фронте.

Новые log-tags: `[perf:poll_memo] hit=true|false mtime_equal=...`, `[perf:ready_computed] n=... computed_ms=...`.

### 3.4 Data flow (changed)

```
Before:
bd_poll_data
├─ sync_bd_database
├─ execute_bd("list --all --limit=0")   ← 1678ms cold
└─ execute_bd("ready")                  ← 717ms cold

After (Dolt, bd ≥ 0.55, mtime unchanged):
bd_poll_data
├─ sync_bd_database (noop for Dolt)
├─ get_beads_mtime → hits POLL_MEMO → return cached
└─ compute_ready_from(cached.open, statuses) ← pure, microseconds

After (Dolt, bd ≥ 0.55, mtime changed / cold):
bd_poll_data
├─ execute_bd("list --all --limit=0")   ← 1 spawn only
├─ compute_ready_from(raw_open, ...)    ← no spawn
└─ insert POLL_MEMO[cwd] = {mtime, raw_*, now}
```

### 3.5 Migration / fallback

- `br` (Rust CLI, `uses_jsonl_files()==true`): старый путь 2-spawn; memo тоже работает (mtime-based), но `compute_ready_from` не применяется — остаётся `bd ready` spawn.
- bd < 0.55 (нет `--all` flag): старый путь 2-spawn (list + list --status=closed) + memo over обе. `ready` отдельным spawn.
- Dolt-проект отсутствует (`project_uses_dolt()==false`): memo применяется по mtime JSONL; `compute_ready_from` может использоваться, если `supports_list_all_flag()==true`.
- Если `compute_ready_from` даёт расхождение с `bd ready` (дебаг-режим через `VERBOSE_LOGGING`), лог warning + fallback на `bd ready` spawn в следующем poll.

### 3.6 Acceptance criteria — ho6

1. На проекте с 1000+ issues second poll cycle (memo-hit) показывает `[perf:bd_poll_data] total_ms < 100`.
2. First poll cycle (cold, memo-miss) показывает `total_ms < 1000` за счёт устранения `op=ready spawn`.
3. Idle CPU минуты (window blurred, mtime не меняется): 0 bd spawn'ов на Dolt-проекте (все poll'ы — memo-hits, верифицируется через `[perf:poll_memo] hit=true`).
4. Unit-тесты для `compute_ready_from` — edge cases: issue без deps / с closed blocker / с open blocker / tombstone / custom status в категории `active` vs `wip`.
5. Regression: существующие tests `pnpm test && npx vue-tsc --noEmit` проходят; `cargo check` green.
6. Проект без Dolt (bd < 0.50 или `br`) — поведение не меняется.

### 3.7 Files changed — ho6

- `src-tauri/src/lib.rs:2667-2799` — `bd_poll_data` rewrite.
- `src-tauri/src/lib.rs` — новые `POLL_MEMO`, `compute_ready_from`, `BUILTIN_STATUS_CATEGORIES` const.
- `src-tauri/tests/` (new file, e.g. `poll_memo_test.rs`) — unit tests для `compute_ready_from`.

---

## 4. Design — Child 2 (v1p)

### 4.1 Problem

`useAdaptivePolling` сейчас жёстко закодирован: 5s/30s/60s/30s (active/blurred/idle/watcher-safety). Для Dolt-проектов с 1000+ issues даже с memo-layer реальный poll (memo-miss) остаётся тяжелее, чем для 50-issue проектов. Нужна адаптация по двум осям: **Dolt-факт** и **размер проекта**.

### 4.2 Approach

Ввести **profile-based interval table** и источник двух сигналов:

1. **Dolt detection** — новая Tauri-команда-геттер `project_uses_dolt(cwd) -> bool` (exposed из существующей rust-fn на lib.rs:1283). Композабл `useProjectMeta` кэширует результат per-cwd.
2. **Project size** — берём `issues.value.length` из `useIssues` (уже reactive; singleton). Классифицируем: `small` (<200), `medium` (200-1000), `large` (≥1000).

Таблица интервалов (новые константы):

| Profile | Active | Watcher-safety | Blurred | Idle |
|---------|-------:|---------------:|--------:|-----:|
| non-Dolt OR small | 5s | 30s | 30s | 60s (без изменений) |
| Dolt + medium | 10s | 45s | 60s | 120s |
| Dolt + large | 15s | 60s | 90s | 180s |

`INTERVAL_CHECK` (fast mtime check — 1s) не меняется: он дешёвый и служит main signal для swift detection. Watcher остаётся primary detector; поллинг — safety net.

### 4.3 Frontend API contract — v1p

```ts
// New Tauri command (Rust-side: thin wrapper)
invoke<boolean>('project_uses_dolt', { cwd: string }) -> Promise<boolean>

// useAdaptivePolling options extension
interface AdaptivePollingOptions {
  checkFn?: () => Promise<boolean>
  checkInterval?: number
  watcherActive?: Ref<boolean>
  profile?: Ref<'default' | 'dolt-medium' | 'dolt-large'>  // NEW
}

// New composable
export function useProjectProfile(cwd: Ref<string | null>): {
  profile: ComputedRef<'default' | 'dolt-medium' | 'dolt-large'>
  isDolt: Ref<boolean>
  size: ComputedRef<'small' | 'medium' | 'large'>
}
```

Источник `size` — `useIssues().issues.value.length` (already shared singleton). `isDolt` — invoke + cache per-cwd в module-scope `Map<string, boolean>`.

### 4.4 Data flow — v1p

```
useIssues.issues (reactive length)
    ↓
useProjectProfile (computed: size × isDolt → profile)
    ↓
useAdaptivePolling({ profile })
    ↓
currentInterval computed — читает INTERVAL_TABLE[profile.value][state]
```

При смене проекта `profile.value` переключается — `scheduleNext()` в watch(currentInterval) автоматически перерасчитывает таймер (логика уже есть через `computed`).

### 4.5 Migration / fallback

- Если `project_uses_dolt` invoke падает → `isDolt = false` → `profile = 'default'` (текущее поведение).
- Если `issues.length === 0` (cold-start до первого poll'а) → `size = 'small'` → `profile = 'default'`.
- Если `watcherActive.value === true` → берётся `INTERVAL_TABLE[profile][watcher-safety]` — fast mtime check и так остаётся primary detector.

### 4.6 Acceptance criteria — v1p

1. На проекте `beads-task-issue-tracker` (Dolt, ~1000 issues) `useAdaptivePolling.currentInterval.value` в active-состоянии = 15000 (log через `logFrontend('info', '[poll] profile=dolt-large interval=15000')`).
2. На non-Dolt или <200 issues проекте — 5000мс (без регрессии).
3. Idle CPU за 1 минуту на Dolt-large проекте падает ≥50% относительно baseline (замер: `[perf:bd_poll_data] total_ms` × частота в `[perf:poll_memo]` logs).
4. Fast mtime check (1s loop) продолжает триггерить immediate poll при изменении mtime — `INTERVAL_ACTIVE`-подмена не ломает watcher integration.
5. Unit-тест для pure-функции выбора profile: `(isDolt, size) → profile`.
6. i18n-nothing: никаких новых user-facing строк (интервалы не показываются в UI).

### 4.7 Files changed — v1p

- `app/composables/useAdaptivePolling.ts` — расширить `AdaptivePollingOptions`, добавить `INTERVAL_TABLE`.
- `app/composables/useProjectProfile.ts` (new).
- `app/utils/bd-api.ts` — экспорт новой Tauri команды.
- `src-tauri/src/lib.rs` — `#[tauri::command] project_uses_dolt(cwd)` wrapper вокруг существующей fn.
- `tests/composables/useProjectProfile.test.ts` (new).
- `app/pages/index.vue` — прокинуть `profile` в `useAdaptivePolling`.

---

## 5. Execution Plan

| Порядок | Child | Область | Файлы | Зависимости |
|---|---|---|---|---|
| 1 | ho6 | Rust backend (bd_poll_data, memo, compute_ready_from) | `src-tauri/src/lib.rs`, `src-tauri/tests/poll_memo_test.rs` | — |
| 2 | v1p | Frontend (adaptive interval profile) | `app/composables/useAdaptivePolling.ts`, `app/composables/useProjectProfile.ts`, `app/utils/bd-api.ts`, `src-tauri/src/lib.rs` (Tauri wrapper), `tests/composables/useProjectProfile.test.ts`, `app/pages/index.vue` | ho6 merged in same branch |

**Один worktree, один PR.** После ho6 измерить baseline поллов (memo hit vs miss), затем на тех же цифрах подобрать пороги v1p (если реальные числа отличаются от гипотезы — скорректировать таблицу из §4.2 **перед** имплементацией).

---

## 6. Risks

1. **`compute_ready_from` semantic drift** — если bd-версия меняет readiness-алгоритм. Митигация: при verbose-log'е в дебаг прогонять одну периодическую сверку `bd ready` vs computed и логировать mismatch.
2. **POLL_MEMO stale при внешнем bd-write** — митигирован через `get_beads_mtime()`; mtime резолюция зависит от FS (APFS — микросекунды, ext4 — секунды). Fallback за счёт `POLL_MEMO_TTL_SECS=60`.
3. **Intervals v1p слишком агрессивны** — пользователь может не увидеть внешнее изменение до 15с. Митигатор: native file watcher (`startWatching`, `useChangeDetection.ts:1`) остаётся primary; интервал — safety-net.
4. **daemon-mode появится позже** — design остаётся совместимым: memo + single-spawn — чистый win; daemon добавляется как ещё один ярус в `execute_bd` под version-gate.

---

## 7. Non-goals

- Upstream bd daemon/socket (отложено — требует работы в `steveyegge/beads`).
- Миграция на Dolt mysql-driver в Rust (дублирует семантику).
- User-facing UI для выбора polling-profile.
