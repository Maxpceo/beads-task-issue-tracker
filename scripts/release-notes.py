#!/usr/bin/env python3
"""
Extract user-facing release notes from CHANGELOG.md for a given version.

Reads CHANGELOG.md, finds the section for the given version, filters out
internal/infra noise (dev-tooling, agent skills, hooks, workflow docs),
and prints clean markdown suitable for GitHub Release body.

Usage:
    python3 scripts/release-notes.py 2.3.0
    python3 scripts/release-notes.py Unreleased
    python3 scripts/release-notes.py 2.3.0 --changelog path/to/CHANGELOG.md
    python3 scripts/release-notes.py 2.3.0 --no-highlights   # skip auto-highlights block

Exit codes:
    0 — success
    1 — version not found / changelog missing
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Entries mentioning any of these patterns (case-insensitive, on the bullet line)
# are excluded as internal/dev-tooling noise. Extend as your taste evolves.
EXCLUDE_PATTERNS = [
    r"\.claude/",
    r"\bCLAUDE\.md\b",
    r"\brelease\.sh\b",
    r"\bcodebase-map\b",
    r"\bworkflow-templates?\b",
    r"\brules-architecture\b",
    r"\bsubagent[s]?\b",
    r"\bsupervisor[s]?\b",
    r"\borchestrator\b",
    r"\bagent body\b",
    r"\bskill[s]?\b(?!\s+(?:tree|level))",  # avoid matching "skill tree" etc., but catch "skill", "skills"
    r"\bhook[s]?\b",
    r"\bdocumentation-expert\b",
    r"\bbead[- ]enrichment\b",
    r"\bmerge[- ]slot\b",
    r"\bworktree[s]?\b",
    r"\bIron Law\b",
    r"\bRAMS\b",
    r"\bWIG\b",
    r"\bhedging\b",
    r"bd remember",
    r"\btests?/\b",
    r"\bvitest\b",
    r"\bvue-tsc\b",
    r"\bcargo check\b",
    r"\bnuxt upgrade\b",
]

# Sections to drop entirely (by heading text, case-insensitive).
DROP_SECTIONS = {
    "internal",
    "fixes",  # typo-section mirror of Fixed — noise
    "workflow & documentation",
    "workflow and documentation",
    "dx",
    "ci",
    "docs",
    "documentation",
    "tests",
    "testing",
    "chore",
    "refactor",
    "refactoring",
}

# Prefixes that mark bullets. Matches "- ", "* ", "+ ".
BULLET_PREFIX = re.compile(r"^[-*+]\s+")

# Matches "## [X.Y.Z]" or "## [Unreleased]" — version heading.
VERSION_HEADING = re.compile(r"^##\s+\[([^\]]+)\]")

# Matches "### Added" etc. — category heading.
CATEGORY_HEADING = re.compile(r"^###\s+(.+?)\s*$")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("version", help="Version to extract (e.g. 2.3.0 or Unreleased)")
    p.add_argument(
        "--changelog",
        default="CHANGELOG.md",
        help="Path to CHANGELOG.md (default: CHANGELOG.md)",
    )
    p.add_argument(
        "--no-highlights",
        action="store_true",
        help="Do not auto-generate a Highlights section",
    )
    p.add_argument(
        "--highlights-count",
        type=int,
        default=3,
        help="Number of auto-highlights to extract (default: 3)",
    )
    return p.parse_args()


def extract_version_section(content: str, version: str) -> list[str]:
    """Return lines belonging to the given version section (excluding the heading itself)."""
    lines = content.splitlines()
    start = None
    for i, line in enumerate(lines):
        m = VERSION_HEADING.match(line)
        if m and m.group(1).strip().lower() == version.lower():
            start = i + 1
            break
    if start is None:
        return []

    end = len(lines)
    for j in range(start, len(lines)):
        if VERSION_HEADING.match(lines[j]):
            end = j
            break
    return lines[start:end]


def is_excluded(bullet_text: str) -> bool:
    """Return True if a bullet matches any EXCLUDE pattern."""
    for pat in EXCLUDE_PATTERNS:
        if re.search(pat, bullet_text, re.IGNORECASE):
            return True
    return False


def split_into_bullets(section_lines: list[str]) -> list[tuple[str, list[str]]]:
    """
    Split a version-section into (category, [bullet-blocks]) pairs, preserving order.
    A bullet block is one logical entry — its first line starts with '-', '*' or '+',
    and continuation lines (indented or blank-inside-bullet) are included.
    """
    result: list[tuple[str, list[str]]] = []
    current_category: str | None = None
    current_bullets: list[str] = []
    current_bullet_buf: list[str] = []

    def flush_bullet() -> None:
        nonlocal current_bullet_buf
        if current_bullet_buf:
            current_bullets.append("\n".join(current_bullet_buf).rstrip())
            current_bullet_buf = []

    def flush_category() -> None:
        nonlocal current_bullets
        flush_bullet()
        if current_category is not None and current_bullets:
            result.append((current_category, current_bullets))
        current_bullets = []

    for line in section_lines:
        cat_match = CATEGORY_HEADING.match(line)
        if cat_match:
            flush_category()
            current_category = cat_match.group(1).strip()
            continue

        if BULLET_PREFIX.match(line):
            flush_bullet()
            current_bullet_buf = [line]
        elif current_bullet_buf and (line.startswith("  ") or line.strip() == ""):
            current_bullet_buf.append(line)
        elif current_bullet_buf:
            flush_bullet()

    flush_category()
    return result


def filter_entries(
    categorized: list[tuple[str, list[str]]],
) -> list[tuple[str, list[str]]]:
    """Drop internal categories, exclude noisy bullets, merge duplicate headings."""
    # Keyed by lowercase category so that '### Fixed' and '### fixed' merge.
    merged: dict[str, list[str]] = {}
    display_name: dict[str, str] = {}  # first-seen casing wins
    order: list[str] = []
    for category, bullets in categorized:
        key = category.lower()
        if key in DROP_SECTIONS:
            continue
        keep_bullets = [b for b in bullets if not is_excluded(b)]
        if not keep_bullets:
            continue
        if key not in merged:
            merged[key] = []
            display_name[key] = category
            order.append(key)
        merged[key].extend(keep_bullets)
    return [(display_name[key], merged[key]) for key in order]


def first_sentence(bullet: str) -> str:
    """Extract a short one-line summary from a bullet (first sentence or bold prefix)."""
    first_line = bullet.splitlines()[0]
    text = BULLET_PREFIX.sub("", first_line).strip()
    # Prefer a **bolded** opener if present
    bold = re.match(r"\*\*(.+?)\*\*", text)
    if bold:
        return bold.group(1).strip().rstrip(".:;,")
    # Otherwise, first sentence up to ". " or ~120 chars
    sentence = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
    if len(sentence) > 120:
        sentence = sentence[:117].rstrip() + "..."
    return sentence


def make_highlights(
    categorized: list[tuple[str, list[str]]], count: int
) -> tuple[list[str], bool]:
    """
    Pick highlights for the release.

    If the CHANGELOG has a curated `### Highlights` section under the version
    heading, use its bullets verbatim (as_curated=True). Otherwise fall back
    to the first N bullets from Added/Fixed/Changed/Removed (as_curated=False).
    """
    for category, bullets in categorized:
        if category.lower() == "highlights":
            return [first_sentence(b) for b in bullets], True

    preferred_order = ["added", "fixed", "changed", "removed"]
    pool: list[str] = []
    for want in preferred_order:
        for category, bullets in categorized:
            if category.lower() == want:
                pool.extend(first_sentence(b) for b in bullets)
    if not pool:
        for _, bullets in categorized:
            pool.extend(first_sentence(b) for b in bullets)
    return pool[:count], False


def render(
    version: str,
    categorized: list[tuple[str, list[str]]],
    highlights: list[str] | None,
) -> str:
    out: list[str] = []
    if highlights:
        out.append("## Highlights")
        out.append("")
        for h in highlights:
            out.append(f"- {h}")
        out.append("")
    out.append("## What's New")
    out.append("")
    # Skip a curated Highlights section so entries don't appear twice.
    for category, bullets in categorized:
        if category.lower() == "highlights":
            continue
        out.append(f"### {category}")
        out.append("")
        for b in bullets:
            out.append(b)
            out.append("")
    return "\n".join(out).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    changelog_path = Path(args.changelog)
    if not changelog_path.exists():
        print(f"error: {changelog_path} not found", file=sys.stderr)
        return 1

    content = changelog_path.read_text(encoding="utf-8")
    section = extract_version_section(content, args.version)
    if not section:
        print(f"error: version [{args.version}] not found in {changelog_path}", file=sys.stderr)
        return 1

    categorized = split_into_bullets(section)
    filtered = filter_entries(categorized)

    if not filtered:
        print(
            f"warning: no user-facing entries found for [{args.version}] after filtering",
            file=sys.stderr,
        )

    highlights: list[str] | None
    if args.no_highlights:
        highlights = None
    else:
        highlights, as_curated = make_highlights(filtered, args.highlights_count)
        if not as_curated and highlights:
            print(
                "note: no curated `### Highlights` section found; "
                "auto-picked first entries from Added/Fixed. "
                "Consider adding an explicit `### Highlights` block to CHANGELOG.",
                file=sys.stderr,
            )

    print(render(args.version, filtered, highlights), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
