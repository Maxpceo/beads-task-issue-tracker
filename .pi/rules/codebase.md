# Pi Codebase Rules

These are Pi-native codebase rules migrated from `PROJECT-CONTEXT.md`. Pi sessions use `AGENTS.md` and `.pi/*` as the source of truth; `.claude/*` and `PROJECT-CONTEXT.md` are references unless an explicit task says otherwise.

## Stack and compatibility

- Frontend: Nuxt 4.4, Vue 3.5 Composition API, TypeScript, Tailwind CSS v4.1, shadcn-nuxt, Lucide Vue Next.
- Backend: Tauri 2.9.5 with Rust.
- Tests: Vitest 4.0 with jsdom.
- Package manager: pnpm 10.
- Issue tracking: bd/beads. Backend code must preserve supported bd compatibility paths documented in `.pi/rules/domain.md` and `src-tauri` helpers.

## DRY / no duplicated business logic

- Do not duplicate business logic between Vue components, composables, utilities, or Rust handlers.
- Put reusable stateful frontend logic in `app/composables/`.
- Put pure/testable frontend logic in `app/utils/` and add/update matching tests when behavior changes.
- Put reusable UI in `app/components/`; use `app/components/ui/` primitives where practical.
- Keep `app/pages/index.vue` as orchestration only: layout, composable wiring, and minimal glue.

## Naming conventions

- TypeScript/Vue variables and functions use `camelCase`.
- Vue components and TypeScript types/interfaces use `PascalCase`.
- Rust functions and variables use `snake_case`; Rust structs/enums/traits use `PascalCase`.
- Tauri commands are `snake_case` in Rust and are called from TypeScript through camelCase wrappers/invoke helpers where the project already exposes them that way.
- Styling should use Tailwind utility classes and project CSS variables/theme tokens instead of inline styles or arbitrary hardcoded values.

## Language and documentation

- Internal code comments and developer-facing documentation in project workflow/rule files are Russian unless the surrounding file has an established English public-facing convention.
- User-visible UI strings must go through i18n and keep English/Russian locale keys synchronized.
- Do not translate user-authored bead content, bd identifiers, file/function names, command names, labels, statuses, or native macOS menu labels.
- Public open-source docs such as `README.md`, `CHANGELOG.md`, release notes, and commit messages remain English unless the user explicitly requests otherwise.
- TypeScript interfaces and their fields should have JSDoc when exported or used as shared contracts.
- Exported functions/composables/hooks should have JSDoc describing purpose and parameters when non-trivial or shared.
- Public Rust functions, structs, and Tauri commands should use `///` doc comments.
- Inline comments should explain non-obvious logic only; do not narrate straightforward code.

## No silent fallbacks

- Do not silently substitute defaults for critical data, paths, command results, bd status, project root, branch, or user-facing state.
- If required data is missing or invalid, surface an explicit error, blocked status, or user-visible message instead of proceeding with potentially wrong data.
- Reviewers should treat silent fallback behavior as a correctness issue unless the fallback is explicitly documented, non-critical, and observable.

## Logging and user-visible errors

- Frontend app code must not use `console.*` except the dedicated console-to-log interceptor.
- Frontend logging uses project utilities from `~/utils/bd-api`, for example `logFrontend(level, '[context] message')`, and should not break UI flows if logging fails.
- Rust app logging uses project macros (`log_info!`, `log_warn!`, `log_error!`, `log_debug!`), not `println!` for app logs.
- User-visible operational logs should reach `~/Library/Logs/com.beads.manager/beads.log`, not only DevTools or terminal output.

## Project structure

| Area | Path |
|---|---|
| Vue components | `app/components/` |
| shadcn/ui primitives | `app/components/ui/` |
| Pages/routes | `app/pages/` |
| Stateful frontend logic | `app/composables/` |
| Pure frontend utilities | `app/utils/` |
| Shared TypeScript types | `app/types/` |
| Rust/Tauri backend | `src-tauri/src/` |
| Tauri config | `src-tauri/tauri.conf.json` |
| Tests | `tests/` mirroring source paths where practical |
| Static assets | `public/` |

## UI/UX implementation rules

- Use Tailwind v4 utilities and existing CSS variables/theme tokens; avoid hardcoded colors and inline styles.
- Preserve automatic dark mode behavior through CSS variables.
- shadcn-nuxt components use the project style conventions (New York style, neutral base color) unless a task explicitly changes the design system.
- Desktop is the primary platform, but UI changes should avoid obvious narrow-width breakage.
- Accessibility is part of implementation and review: keyboard access, visible focus, labels for icon-only controls, semantic elements, sufficient contrast, and non-color-only state indicators.

## Agent delivery expectations

- Typed Pi workflows (`dispatch_supervisor`, `dispatch_reviewer`, `dispatch_docs_agent`, `review_bead`) must deliver these rules through `PATH_RULES_LOADED` by loading `.pi/rules/codebase.md` as a global rule file.
- Generic `subagent` calls do not automatically render path rules. If a generic subagent needs codebase rules, the orchestrator should either use a typed workflow tool or include the relevant rule context/task instructions explicitly.
- Active project agents should treat `AGENTS.md`, `.pi/rules/domain.md`, and this file as the Pi source of truth for codebase behavior.
