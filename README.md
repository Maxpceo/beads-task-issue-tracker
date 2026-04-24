# Beads Task-Issue Tracker

A lightweight, standalone desktop application for managing [Beads](https://github.com/steveyegge/beads) issues outside of your IDE.

![Beads Task-Issue Tracker](docs/screenshots/app-overview-1.23.0.png)

> **Community Fork** — This is the actively maintained version of Beads Task-Issue Tracker.
> The original author discontinued the project, and this fork continues development to keep the app functional, add new features, and support the Beads community.

## Why This App?

[Beads](https://github.com/steveyegge/beads) is an AI-native issue tracker that stores issues directly in your codebase (in a `.beads` folder). Compatible with both [`br`](https://github.com/Dicklesworthstone/beads_rust) (Rust, recommended) and [`bd`](https://github.com/steveyegge/beads) (Go).

> **A human interface for AI-piloted issue tracking**
>
> The Beads CLI (`br` or `bd`) is designed for AI agents — they create issues, update statuses, and pilot workflows programmatically. But **humans need visibility and control** over what the AI is doing.
>
> This application lets you **observe** what the AI is driving, and **step in** to edit, correct, or redirect at any point. The workflow is collaborative — the AI pilots through the CLI, and you use this app as your control panel.

Planet57's [vscode-beads extension](https://marketplace.visualstudio.com/items?itemName=planet57.vscode-beads) provides an excellent interface for managing these issues.
However, **VS Code can be resource-intensive**.
If you want to browse and manage your Beads issues without keeping VS Code open, this standalone app is for you.

This project is a reimplementation of the Beads UI as a native desktop app using [Tauri](https://tauri.app/), resulting in:
- **Minimal memory footprint** (~50MB vs VS Code's 500MB+)
- **Fast startup** (instant vs several seconds)
- **Dedicated window** for issue management
- **Works alongside any editor** (Vim, Emacs, JetBrains, etc.)

## Features

### Live Updates — No Polling
The app uses a **native file watcher** on the `.beads` directory. When an AI agent (or anyone) creates, updates, or closes an issue via `br` or `bd`, the change appears in real time — no refresh button, no polling interval. This is critical when monitoring AI-driven workflows where issues change rapidly.

### Dependencies & Relations
- **Add/remove blockers** from the issue preview via a search modal
- **Navigate** to any dependency or relation by clicking its row (short ID + title)
- **Blocked indicator** in the issue table for issues with unresolved blockers
- **Add/remove relations** (`relates-to`, `duplicates`, `supersedes`, `caused-by`, etc.) between any issues, including closed ones
- **Dynamic relation types** adapted to your CLI client (`bd` or `br`)

### Core
- **Dashboard**: Visual overview of issues by status, type, and priority
- **Issue Management**: Create, edit, close, and comment on issues
- **Epic Hierarchy**: Parent/child relationships with collapsible groups and inline progress bars
- **Multi-Project Support**: Save favorite projects and switch between them instantly

### Attachments
- **Image Attachments**: Attach and preview screenshots directly in issues (thumbnail gallery)
- **Markdown Attachments**: Attach `.md` files with full preview, inline editing, and save workflow
- **Markdown Search**: Find text within markdown previews with match highlighting and navigation (`Cmd/Ctrl+F`)
- **Gallery Navigation**: Browse multiple attached files with arrow keys or buttons

### Filtering & Display
- **Dynamic Status Support**: All statuses from your `bd` installation are automatically loaded — including the bd 1.0.x review chain (`inreview`, `simplified`, `reviewed`, `accepted`) and any custom statuses you define. No hard-coded whitelist; the status filter dropdown always reflects your actual database
- **Workflow filter derived from bd categories**: The Workflow KPI filter automatically includes every status whose bd category is `active`, `wip`, or `frozen` — so `blocked`, `inreview`, `simplified`, `reviewed`, `accepted`, and any custom `wip` status you define with `bd statuses` are all covered without manual configuration. Click the Workflow KPI card to apply the filter
- **Done KPI card**: A dedicated KPI card shows the count of closed issues. Clicking it filters the table to `status=closed`. Appears in both desktop sidebar and narrow-window layout
- **Deferred KPI respects custom frozen statuses**: The Deferred counter includes all issues whose bd status has `category='frozen'` (excluding `pinned`). If you define custom frozen statuses via `bd statuses` (e.g. `on_hold`, `waiting`), they are automatically counted — no configuration needed
- **Advanced Filters**: Multi-select filters by type, status, priority, labels, and assignee
- **Exclusion Filters**: Hide specific issues by criteria (inverse filtering)
- **Search**: Find issues by `id`, `title`, `description`, `labels`, `workingNotes`, `acceptanceCriteria`, `designNotes`, or `comments` — 8 fields, case-insensitive substring. When the search field is non-empty, active filters and exclusions are bypassed — matching Jira/Linear semantics so any issue is reachable regardless of the current filter state
- **Cmd+K Command Palette**: Global cross-project search (`Cmd+K` / `Ctrl+K`). Linear/VS Code-style overlay that searches all sidebar projects simultaneously — results show id, title, status, priority, and project badges. Selecting a result switches to that project and opens the issue. Full keyboard navigation (↑↓ Enter Esc); errors for individual projects shown as non-blocking badges
- **Column Customization**: Show/hide and configure table columns per project
- **Smart Short IDs**: Common prefix is automatically detected and hidden for readability
- **Collapsible Sections**: All preview sections (description, attachments, dependencies, etc.) are independently collapsible with persistent state

### Bulk & Productivity
- **Multi-Select**: Toggle multi-select mode to select issues individually or all at once
- **Bulk Delete**: Delete multiple selected issues in one operation
- **Multi-Copy Issue IDs**: Hold `Cmd` (macOS) or `Ctrl` (Windows/Linux) and click any copy-ID button — in the QuickList sidebar, the issue table rows, or the issue detail header — to accumulate IDs in a shared clipboard buffer as a comma-separated list. Click an already-selected item to remove it; a plain click resets the buffer and copies a single ID
- **Sortable Columns**: Click any column header to sort (ascending, descending, or clear)
- **Float active tasks to top**: When enabled (default ON), tasks in the `wip` status category (`in_progress`, `inreview`, `simplified`, `reviewed`, `accepted`, and any custom `wip` status) always float above other tasks regardless of the sort column. Toggle in Settings → Display Options
- **Zoom Controls**: Adjust UI scale from 75% to 150% (Alt+Click to reset)

### Notifications
- **Notification Center**: Bell icon in the header opens a macOS-style notification history panel. The last 100 toast notifications are persisted per project (localStorage). Click any entry to open the related issue; an unread count badge appears on the bell icon when there are unseen notifications. Auto-marks all as read on open. Clear All button wipes the history

### Settings & Tools
- **English + Russian UI**: The interface is fully localized in English and Russian. The language is auto-detected from your system (`navigator.language`); you can override it at any time via Settings → Language (Auto / English / Русский). The choice is persisted to `localStorage['beads:locale']` and takes effect immediately without a restart
- **Dual CLI support**: Auto-detects [`br`](https://github.com/Dicklesworthstone/beads_rust) (Rust, recommended) and [`bd`](https://github.com/steveyegge/beads) (Go) — switch between them via Settings (`Cmd/Ctrl+,`), feature profiles adapt automatically
- **Status Color Overrides**: Assign a custom solid color or two-stop gradient to any status badge in Settings. Changes apply instantly across the entire app and are persisted per project. A Reset button returns any badge to its default theme color
- **Theme System**: 4 themes — Classic Light, Classic Dark, Dark Flat, and Neon — with per-theme badge styling, glow effects, and one-click cycling via the header icon
- **Debug Panel**: Live log viewer with auto-refresh, accessible via `Cmd/Ctrl+Shift+L`
- **Database Repair**: Automatic detection and repair of schema migration issues
- **Keyboard Shortcuts**: `Cmd/Ctrl+K` (command palette), `Cmd/Ctrl+,` (settings), `Cmd/Ctrl+F` (search in markdown), `Cmd/Ctrl+Shift+L` (debug logs), arrow keys (gallery navigation), `Cmd/Ctrl+click` on any copy-ID button (multi-copy accumulate)

### New in v2.0.0
- **Resizable comment section**: Drag the bottom edge to resize (160-500px), height persisted per project
- **Comment navigation**: Table of contents with quick jump to any comment
- **Dev script**: `./start-dev.sh` — one-command development setup with dependency checks

## How Attachments Work

The Beads CLI has no built-in attachment support. This app implements its own **filesystem-based attachment system** using the `.beads/attachments/` directory as the sole source of truth.

When you attach files to an issue:
1. Files are copied into `.beads/attachments/{issue-id}/`
2. The app detects attachments by scanning the filesystem directory
3. Multiple files (images and markdown) can be attached in a single operation
4. Files are categorized automatically by extension (image, markdown, or external reference)

This means the attachment storage lives inside the `.beads` directory and gets versioned alongside your issues.

> **For developers**: If you want to script attachment creation (e.g., automatically attach files when creating issues), see the detailed technical documentation in **[docs/attachments.md](docs/attachments.md)**.

## Prerequisites

> **Important**: This app requires a Beads CLI to be installed on your system. It acts as a graphical interface for the Beads command-line tool.

### Recommended: `br` (beads_rust)

[**beads_rust**](https://github.com/Dicklesworthstone/beads_rust) (`br`) is the **recommended CLI** — it's faster, more optimized, and built on the proven SQLite + JSONL architecture.

1. **Install `br`** — follow the instructions at [github.com/Dicklesworthstone/beads_rust](https://github.com/Dicklesworthstone/beads_rust)

2. **Initialize Beads in your project**
   ```bash
   cd your-project
   br init
   ```

3. **Verify installation**
   ```bash
   br --version
   ```

The app **auto-detects** which CLI is installed. You can switch between `br` and `bd` at any time via **Settings** (`Cmd/Ctrl+,`).

### Also supported: `bd` (Go)

[**bd**](https://github.com/steveyegge/beads) (`bd`) is fully supported across versions. The app auto-detects the installed bd version and adapts its behavior accordingly:

- **bd 0.57+**: self-managing Dolt server — starts automatically on first command, no manual setup needed
- **bd 1.0.x**: all review-chain statuses (`inreview`, `simplified`, `reviewed`, `accepted`) and custom statuses are now rendered correctly
- **bd 0.49.x**: the last stable Go version with embedded Dolt, still supported as a fallback

```bash
# Install bd (check the repo for the latest method)
curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash
```

### Using Both Side by Side

`br` and `bd` can be installed simultaneously. The app lets you switch between them at any time via Settings — useful for comparing behavior or transitioning gradually.

## Installation

### Download

Download the latest release from the [Releases](https://github.com/Maxpceo/beads-task-issue-tracker/releases) page:

- **macOS**: `.dmg` file (Apple Silicon & Intel)
- **Windows**: `.msi` or `.exe` installer
- **Linux**: `.deb` (Debian/Ubuntu) or `.AppImage`

### macOS: First Launch

macOS may block the app because it's not signed with an Apple Developer certificate. To fix this, run:

```bash
xattr -cr /Applications/Beads\ Task-Issue\ Tracker.app
```

Then open the app normally. This only needs to be done once.

### Build from Source

```bash
# Clone the repository
git clone https://github.com/Maxpceo/beads-task-issue-tracker.git
cd beads-task-issue-tracker

# Install dependencies
pnpm install

# Run in development mode (recommended)
./start-dev.sh

# Or run manually
pnpm tauri:dev

# Build for production
pnpm tauri:build
```

## Tech Stack

| Layer | Technology | Description |
|-------|------------|-------------|
| **Desktop** | [Tauri 2](https://tauri.app/) | Rust-based framework for building lightweight native apps |
| **Framework** | [Nuxt 4](https://nuxt.com/) | Vue 3 meta-framework running in SPA mode |
| **UI Components** | [shadcn-vue](https://www.shadcn-vue.com/) | Beautifully designed, accessible component library |
| **Styling** | [TailwindCSS 4](https://tailwindcss.com/) | Utility-first CSS framework |
| **Language** | TypeScript / Rust | Type-safe frontend with Rust backend |

## Related Projects

- [bd Beads](https://github.com/steveyegge/beads) - The AI-native issue tracker by Steve Yegge
- [Beads VS Code Extension](https://marketplace.visualstudio.com/items?itemName=planet57.vscode-beads) - The Planet57 VS Code extension
- [Community Tools](https://github.com/steveyegge/beads/blob/main/docs/COMMUNITY_TOOLS.md) - Other Beads community projects

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

This repository ships a `.claude/` directory containing agent definitions, workflow hooks, and skills for use with [Claude Code](https://claude.ai/code). If you contribute using Claude Code, these files are picked up automatically and enforce the project's workflow discipline (issue tracking, code review, branch hygiene). `.claude/settings.local.json` is gitignored and stays machine-local.

## License

[MIT](LICENSE)

---

## Acknowledgments

Originally created by Laurent Chapin ([w3dev33](https://github.com/w3dev33)), who has since moved on to other projects and discontinued maintenance of this repository. Active development is now continued by Maksim Posudevskii ([Maxpceo](https://github.com/Maxpceo)) with the help of [Claude Code](https://claude.ai/code).
