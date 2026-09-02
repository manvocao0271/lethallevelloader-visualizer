"""
copied_lethallevelloader.cfg cleanup tool.

Strips any level name from a dungeon's "Manual Level Names List" that
doesn't match an actual "Custom Level" or "Vanilla Level" section in this
cfg (e.g. leftover references to modded levels you don't have installed).

How to use:
    Run this script: python clean_cfg.py
    The original copied_lethallevelloader.cfg is never modified - the result
    is written to a new file instead (see OUTPUT_CFG_PATH).
"""

from __future__ import annotations

import re
from pathlib import Path

SOURCE_CFG_PATH = Path(__file__).resolve().parent / "copied_lethallevelloader.cfg"
OUTPUT_CFG_PATH = SOURCE_CFG_PATH.with_name("LethalLevelLoader.cleaned.cfg")

# Matches a section header line, e.g. "[Custom Level:  134 Oldred]".
SECTION_HEADER_RE = re.compile(r"^\[(?P<inner>.*)\]\s*$")
ZERO_WIDTH_SPACE = "\u200b"
LEADING_NUMBER_RE = re.compile(r"^\d+\s+")
# Matches one "Name:Weight" entry within a comma-separated list.
PAIR_RE = re.compile(r"^(?P<name>.+):(?P<weight>-?\d+(?:\.\d+)?)$")
MANUAL_LEVEL_NAMES_KEY = "Dungeon Injection Settings - Manual Level Names List"


def parse_header(header_line: str) -> tuple[str, str]:
    """Return (category, name) for a section header, e.g.
    "[Custom Level:  134 Oldred]" (with zero-width spaces) -> ("Custom Level", "Oldred")."""
    match = SECTION_HEADER_RE.match(header_line.rstrip("\r\n"))
    if not match:
        return ("", "")
    inner = match.group("inner").replace(ZERO_WIDTH_SPACE, "").strip()
    if ":" not in inner:
        return (inner, "")
    category, name = inner.split(":", 1)
    name = LEADING_NUMBER_RE.sub("", name.strip()).strip(" -")
    return (category.strip(), name)


def find_sections(lines: list[str]) -> list[tuple[str, str, int, int]]:
    """Return (category, name, start, end) for each section, where lines
    [start:end] covers the header line through the line before the next
    header (or end of file)."""
    header_indices = [i for i, line in enumerate(lines) if SECTION_HEADER_RE.match(line)]
    header_indices.append(len(lines))

    sections = []
    for idx in range(len(header_indices) - 1):
        start, end = header_indices[idx], header_indices[idx + 1]
        category, name = parse_header(lines[start])
        sections.append((category, name, start, end))
    return sections


def remove_uninstalled_level_references(lines: list[str]) -> int:
    """Strip any "Name:Weight" entry from every dungeon's Manual Level Names
    List whose name doesn't match a "Custom Level"/"Vanilla Level" section
    present in this cfg. Returns the number of entries removed."""
    sections = find_sections(lines)
    installed_levels = {
        name for category, name, _, _ in sections if category in ("Custom Level", "Vanilla Level")
    }
    dungeon_sections = [
        (start, end) for category, _, start, end in sections
        if category in ("Custom Dungeon", "Vanilla Dungeon")
    ]

    prefix = f"{MANUAL_LEVEL_NAMES_KEY} = "
    removed = 0

    for start, end in dungeon_sections:
        for i in range(start, end):
            stripped = lines[i].rstrip("\r\n")
            if not stripped.startswith(prefix):
                continue

            original_pairs = []
            for chunk in stripped[len(prefix):].split(","):
                match = PAIR_RE.match(chunk.strip())
                if match:
                    original_pairs.append((match.group("name").strip(), match.group("weight")))

            kept_pairs = [pair for pair in original_pairs if pair[0] in installed_levels]
            if len(kept_pairs) != len(original_pairs):
                removed += len(original_pairs) - len(kept_pairs)
                new_value = ",".join(f"{name}:{weight}" for name, weight in kept_pairs)
                line_ending = lines[i][len(stripped):]
                lines[i] = f"{MANUAL_LEVEL_NAMES_KEY} = {new_value}{line_ending}"
            break

    return removed


def main() -> None:
    if not SOURCE_CFG_PATH.exists():
        raise FileNotFoundError(f"Could not find config file at {SOURCE_CFG_PATH}")

    lines = SOURCE_CFG_PATH.read_text(encoding="utf-8").splitlines(keepends=True)

    removed = remove_uninstalled_level_references(lines)
    print(f"Removed {removed} level reference(s) not present as a level in this cfg.")

    OUTPUT_CFG_PATH.write_text("".join(lines), encoding="utf-8")
    print(f"Wrote {OUTPUT_CFG_PATH.name}")


if __name__ == "__main__":
    main()
