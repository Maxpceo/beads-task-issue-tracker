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
| `.pi/extensions/agent-models/index.ts` — `MenuUi` ~L1071 | whitelist без `custom` (антипаттерн) |
| тот же файл — `handleAgentModelsInvocation` ~L1600 | стрипает `ui.custom` / `ctx.mode` при сборке MenuUi |
| `.pi/extensions/session-replay/index.ts` | static import `@earendil-works/pi-tui`, **sync** `ui.custom` factory |
| `tests/mocks/pi-tui.ts` | vitest alias; есть `Text`/`Container.addChild`, **нет** `Input`/`SelectList`/`Container.clear` |
| `tests/extensions/extension-entrypoints.test.ts` | default export factory обязателен |
| `vitest.config.ts` | alias `@earendil-works/pi-tui` → mock |

## Checklist (11)

### 1. Default export factory

Каждый `.pi/extensions/<name>/index.ts` — `export default function …(pi): void`. Named-only exports ломают runtime load и `extension-entrypoints.test.ts`. См. `.pi/rules/domain.md` «Pi extension entrypoints».

### 2. `ui.custom(factory)` — factory синхронная

```ts
await ctx.ui.custom((tui, theme, keybindings, done) => {
  // сразу return Component — без await import внутри factory
  return { render, handleInput, invalidate, /* focused get/set if needed */ };
});
```

Запрещено: `await import(...)` / async factory body до `return`. Static import модулей tui наверху файла (как session-replay).

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

При сборке `MenuUi` / command ctx **форвардить** `ctx.ui.custom` и `ctx.mode` (и registry/catalog sources). Антипаттерн: `handleAgentModelsInvocation` whitelist `{ select, input, notify, confirm }` без `custom` — custom path мёртв даже в TUI.

### 6. Русский лейбл фильтра — sibling `Text`

Заголовок/подсказка фильтра — отдельный `Text` child. Chrome `Input` может остаться `"> "`. **Не** пихать product copy в `Input.prompt` / `placeholder` (ненадёжный chrome для RU UX).

### 7. SelectList theme — 3-й аргумент

```ts
new SelectList(items, maxVisible, (t) => theme.fg("accent" | "muted" | "dim", t))
// или объект theme из factory `theme`, согласованный с Pi examples
```

Бери `theme` из factory args, не hardcode ANSI.

### 8. Key routing через keybindings

Сначала:

`keybindings.matches(data, "tui.select.cancel" | "tui.select.confirm" | "tui.select.up" | "tui.select.down")`

- Enter / confirm = выбранный **item** SelectList.
- **Не** `done(input.getValue())` на Enter, если value — search query, а не выбор модели/пункта.
- Escape / cancel → `done(undefined)` / no write.

### 9. Sentinels: value ≠ label

| value (id) | label (UI) |
|---|---|
| `__other__` | `Другая…` |
| `__back__` / back id | `← Назад` |

Нормализовать **оба** до write в JSON/config. Сравнение и persist — по value/id, не по русской строке.

### 10. Vitest mock gap

Alias → `tests/mocks/pi-tui.ts`. Перед тестами с `Input` / `SelectList` / `Container.clear` **дописать mock**:

- `Input`: `getValue` / `setValue` / `focused` / `handleInput`
- `SelectList(items, maxVisible, theme?)` + selection API, нужный коду
- `Container.clear()`

Иначе: green unit tests / red live TUI (или наоборот — import fail в tests).

### 11. Static import `pi-tui`, без `package.json`

```ts
import { Container, Input, SelectList, Text } from "@earendil-works/pi-tui";
```

Как session-replay. **Не** добавлять `@earendil-works/pi-tui` в project `package.json` — runtime резолвит из Pi; tests через vitest alias.

## Минимальный каркас custom picker

```ts
import { Container, Input, SelectList, Text } from "@earendil-works/pi-tui";

// guard: ctx.mode === "tui" && typeof ui.custom === "function"
const result = await ui.custom<string | undefined>((tui, theme, keybindings, done) => {
  const root = new Container();
  // Text title + Input search + SelectList(filtered, Math.min(n, 10|15), themeFn)
  // on query change: clear + new SelectList; keys via keybindings; done(id) / done(undefined)
  return {
    render: (w) => root.render(w),
    handleInput: (data) => { /* route keys */; tui.requestRender(); },
    invalidate: () => {},
  };
});
```

Детали API — Pi docs/examples; здесь только порядок ловушек.

## Out of skill scope

- Реализация конкретного picker (khec / agent-models) — отдельный bead
- Копирование Pi docs / preset.ts в репо
- npm dependency на `pi-tui`
- `.claude/*`, global `~/.pi` skill
- Авто-lint описаний bd

## Verification после правки extension

- `pnpm exec vitest run tests/extensions/extension-entrypoints.test.ts` — default export
- Фокусные tests расширения; mock дополнен, если нужны Input/SelectList/clear
- Live TUI: custom path при `mode===tui`; fallback без hang; cancel = no write
