---
name: pi-extension
description: Thin project checklist for authoring Pi extensions under .pi/extensions — ctx.ui.custom factories, SelectList/Input product filters, MenuUi forwarding, and pi-tui vitest mock gaps. Use when editing extension TUI menus, searchable pickers, or custom overlays.
---

# Pi extension (thin checklist)

## Сначала docs, не копипаста

1. Прочитай канон Pi: `docs/extensions.md`, `docs/tui.md`, `examples/extensions/` (в пакете `@earendil-works/pi-coding-agent`).
2. **Не** копируй `preset.ts`, длинные d.ts или куски docs в этот репозиторий.
3. При сомнении в API — skill `find-docs`, не догадки и не skills.sh encyclopedia.
4. Этот skill = **ловушки проекта** (MenuUi strip, mock gap, filter), не полный API reference.

## Когда открывать

- Правка / новая `.pi/extensions/<name>/index.ts`
- `ctx.ui.custom`, `SelectList`, `Input`, `Container`, overlay
- Searchable picker / compact list вместо plain `ui.select`
- Vitest падает или «зелёный» при alias на `tests/mocks/pi-tui.ts`

## Read-only якоря в репо

| Якорь | Зачем |
|---|---|
| `.pi/extensions/agent-models/index.ts` — `MenuUi` ~L1071 | whitelist без `custom` (антипаттерн, historical) |
| тот же файл — `handleAgentModelsInvocation` | должен **форвардить** `ui.custom` / `ctx.mode` (fixed) |
| `.pi/extensions/agent-models/searchable-picker.ts` | product searchable picker: overlayOptions + SelectList onSelect/onCancel + pad |
| `.pi/extensions/session-replay/index.ts` | static import `@earendil-works/pi-tui`, **sync** `ui.custom` factory + nested `overlayOptions` |
| `tests/mocks/pi-tui.ts` | vitest alias; Input/SelectList/Container.clear + Key + onSelect/onCancel instance props |
| `tests/extensions/extension-entrypoints.test.ts` | default export factory обязателен |
| `vitest.config.ts` | alias `@earendil-works/pi-tui` → mock |

## Checklist (11)

### 1. Default export factory

Каждый `.pi/extensions/<name>/index.ts` — `export default function …(pi): void`. Named-only exports ломают runtime load и `extension-entrypoints.test.ts`. См. `.pi/rules/domain.md` «Pi extension entrypoints».

### 2. `ui.custom(factory, overlayOptions?)` — factory синхронная

```ts
await ctx.ui.custom(
  (tui, theme, keybindings, done) => {
    // сразу return Component — без await import внутри factory
    return { render, handleInput, invalidate, /* focused get/set if needed */ };
  },
  // Near-fullscreen product overlays (session-replay / agent-models canon):
  {
    overlay: true,
    overlayOptions: {
      width: "90%",
      minWidth: 50,
      maxHeight: "85%",
      anchor: "center",
      margin: 1,
    },
  },
);
```

- Default `ui.custom(factory)` **без** второго аргумента — **не** overlay (Pi docs Overlay Mode). Для near-fullscreen picker/overlay передавай nested `overlayOptions` явно.
- Запрещено: `await import(...)` / async factory body до `return`. Static import модулей tui наверху файла (как session-replay).

### 3. Product-filter списка ≠ `SelectList.setFilter`

`setFilter` — prefix по `item.value`, не product substring search. Для своего фильтра: держать данные снаружи → **recreate** list: `Container.clear()` + `addChild(new SelectList(...))` (паттерн preset searchable list). Не мутировать «тихий» filter API под product UX.

### 4. Custom UI только в TUI mode

```ts
if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") { /* custom path */ }
```

- RPC / json / print: `custom()` может вернуть `undefined` даже при `hasUI === true`.
- **Не** использовать `hasUI` как proxy для mode: cancel ≠ «нет TUI».
- Fallback: `input` + capped `select`, без hang.

### 5. Handler не стрипает `custom` и `mode`

При сборке `MenuUi` / command ctx **форвардить** `ctx.ui.custom` и `ctx.mode` (и registry/catalog sources). Антипаттерн (historical): `handleAgentModelsInvocation` whitelist `{ select, input, notify, confirm }` без `custom` — custom path мёртв даже в TUI. Current path (fixed): forward `custom` + `mode`.

### 6. Русский лейбл фильтра — sibling `Text`

Заголовок/подсказка фильтра — отдельный `Text` child. Chrome `Input` может остаться `"> "`. **Не** пихать product copy в `Input.prompt` / `placeholder` (ненадёжный chrome для RU UX).

### 7. SelectList theme — 3-й аргумент

```ts
new SelectList(items, maxVisible, (t) => theme.fg("accent" | "muted" | "dim", t))
// или объект theme из factory `theme`, согласованный с Pi examples
```

Бери `theme` из factory args, не hardcode ANSI.

### 8. agent-models overlay / handleInput contract (не generic ui.custom default)

Это **product contract** `.pi/extensions/agent-models/searchable-picker.ts`, не default для любого `ui.custom`.

1. Второй аргумент `custom(factory, MODEL_PICKER_OVERLAY_OPTIONS)` — nested `overlayOptions` (см. §2).
2. Каждый rebuild: `next.onSelect = (item) => finish(item.value)`; `next.onCancel = () => finish(null)` — **instance props**, не 4-й ctor arg.
3. `handleInput`:
   - `if (settled) return`
   - pageUp/pageDown → no-op (не `list.handleInput`, не Input, не `requestRender`)
   - иначе `list.handleInput(data)`; если `settled` → return
   - skip Input when keybindings match confirm/cancel/up/down **или** data is `\r`/`\n` **или** starts with `\x1b`
   - иначе Input + rebuild on query change; `if (!settled) requestRender()`
4. Render pad: после `root.render` **append** empty lines while `length < MODEL_PICKER_MIN_RENDER_LINES` (100); never prepend; title/filter markers remain in first lines.
5. Path (a): throw until first return of `runSearchableModelPicker` → `pickModelId` catch **only** around that await; notify with `err.message`, then fallback select.
6. Path (b): try/catch **only** inside returned `handleInput` → `finish(null)`, no notify, no rethrow.

Preset-style selection is SelectList callbacks + `list.handleInput`, not hand-rolled up/down index math as the primary path.

### 9. Sentinels: value ≠ label

| value (id) | label (UI) |
|---|---|
| `__other__` | `Другая…` |
| `__back__` / back id | `← Назад` |

Нормализовать **оба** до write в JSON/config. Сравнение и persist — по value/id, не по русской строке.

### 10. Vitest mock gap

Alias → `tests/mocks/pi-tui.ts`. Перед тестами с `Input` / `SelectList` / `Container.clear` **дописать mock**:

- `Key` (escape/enter/up/down/pageUp/pageDown)
- `Input`: `getValue` / `setValue` / `focused` / `handleInput`
- `SelectList(items, maxVisible, theme?)` + `setSelectedIndex` / `getSelectedItem`
- **Instance** optional `onSelect?` / `onCancel?` (not ctor callbacks)
- `handleInput`: Key.up/down wrap index; Key.enter/`\r` → onSelect if item; Key.escape/`\x1b` → onCancel; page no-op
- `Container.clear()`

Иначе: green unit tests / red live TUI (или наоборот — import fail в tests).

Для path (b) / page unit: `vi.spyOn(SelectList.prototype, "handleInput")` + `mockRestore` in the same `afterEach`; never leave a throw stub; do not replace `comp.handleInput`.

### 11. Static import `pi-tui`, без `package.json`

```ts
import { Container, Input, SelectList, Text } from "@earendil-works/pi-tui";
```

Как session-replay. **Не** добавлять `@earendil-works/pi-tui` в project `package.json` — runtime резолвит из Pi; tests через vitest alias.

## Минимальный каркас custom picker

```ts
import { Container, Input, Key, SelectList, Text } from "@earendil-works/pi-tui";

// guard: ctx.mode === "tui" && typeof ui.custom === "function"
const result = await ui.custom<string | undefined>(
  (tui, theme, keybindings, done) => {
    const root = new Container();
    // Text title + Input search + SelectList(filtered, viewport, themeObj)
    // on query change: clear + new SelectList; wire onSelect/onCancel each rebuild
    // handleInput → list.handleInput first; Input only for non-nav keys
    // render: append pad empty lines for overlay height if product needs it
    return {
      render: (w) => root.render(w),
      handleInput: (data) => { /* route keys */; tui.requestRender(); },
      invalidate: () => {},
    };
  },
  {
    overlay: true,
    overlayOptions: {
      width: "90%",
      minWidth: 50,
      maxHeight: "85%",
      anchor: "center",
      margin: 1,
    },
  },
);
```

Детали API — Pi docs/examples; здесь только порядок ловушек. Full agent-models overlay/handleInput contract → §8 + `searchable-picker.ts`.

## Out of skill scope

- Other agent-models **product** details (catalog/refresh, spawn/dispatch `--model`, thinking-level search UI) — separate beads
- Копирование Pi docs / preset.ts в репо
- npm dependency на `pi-tui`
- global `~/.pi` skill
- Авто-lint описаний bd

## Verification после правки extension

- `pnpm exec vitest run tests/extensions/extension-entrypoints.test.ts` — default export
- Фокусные tests расширения; mock дополнен, если нужны Input/SelectList/clear/Key/onSelect
- Live TUI: custom path при `mode===tui`; overlay options when required; fallback без hang; cancel = no write
