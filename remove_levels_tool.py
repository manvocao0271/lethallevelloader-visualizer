"""
copied_lethallevelloader.cfg level/moon removal tool.

How to use:
    1. Set LEVELS_TO_REMOVE below to a comma-separated list of moon/level
       names (e.g. "Oldred, Gratar, Auralis").
    2. Run this script: python remove_levels_tool.py
    3. The original copied_lethallevelloader.cfg is never modified - the result
       is written to a new file instead (see OUTPUT_CFG_PATH).

A "section" is everything between one "[...]" header and the next. Each
section's name is matched against LEVELS_TO_REMOVE (case-insensitive,
ignoring any leading catalogue number such as "134 Oldred" -> "Oldred").
Matching sections are removed entirely.
"""

from __future__ import annotations

import re
from pathlib import Path

# ============================================================
# CONFIG - list the moons/levels to remove, then run the script
# ============================================================

LEVELS_TO_REMOVE = ""

# ============================================================

SOURCE_CFG_PATH = Path(__file__).resolve().parent / "copied_lethallevelloader.cfg"
OUTPUT_CFG_PATH = SOURCE_CFG_PATH.with_name("LethalLevelLoader.removed.cfg")

ZERO_WIDTH_SPACE = "\u200b"
SECTION_HEADER_RE = re.compile(r"^\[(?P<inner>.*)\]\s*$")
LEADING_NUMBER_RE = re.compile(r"^\d+\s+")


def section_name(header_line: str) -> str:
    """Extract the comparable name from a section header line, e.g.
    "[Custom Level:  134 Oldred]" (with zero-width spaces) -> "Oldred"."""
    match = SECTION_HEADER_RE.match(header_line.rstrip("\r\n"))
    if not match:
        return ""
    inner = match.group("inner").replace(ZERO_WIDTH_SPACE, "").strip()
    name = inner.split(":", 1)[-1].strip() if ":" in inner else inner
    return LEADING_NUMBER_RE.sub("", name).strip(" -")


def split_into_sections(lines: list[str]) -> list[list[str]]:
    """Split the raw lines of a cfg file into sections, each starting with
    its "[...]" header line."""
    sections: list[list[str]] = []
    for line in lines:
        if SECTION_HEADER_RE.match(line.rstrip("\r\n")):
            sections.append([line])
        elif sections:
            sections[-1].append(line)
        else:
            # Content before the first header (shouldn't normally happen).
            sections.append([line])
    return sections


def remove_levels(
    source_path: Path, output_path: Path, level_names: list[str]
) -> tuple[int, list[str]]:
    """Write output_path as a copy of source_path with any section whose
    name matches level_names removed. Returns (sections_removed, names_not_found)."""
    lines = source_path.read_text(encoding="utf-8").splitlines(keepends=True)
    sections = split_into_sections(lines)

    wanted = {name.strip().lower() for name in level_names if name.strip()}
    found = set()

    kept_sections = []
    removed_count = 0
    for section in sections:
        name = section_name(section[0]).lower()
        if name in wanted:
            found.add(name)
            removed_count += 1
            continue
        kept_sections.append(section)

    not_found = [
        name for name in level_names if name.strip() and name.strip().lower() not in found
    ]

    output_path.write_text(
        "".join(line for section in kept_sections for line in section), encoding="utf-8"
    )
    return removed_count, not_found


def main() -> None:
    if not SOURCE_CFG_PATH.exists():
        raise FileNotFoundError(f"Could not find config file at {SOURCE_CFG_PATH}")

    level_names = [name.strip() for name in LEVELS_TO_REMOVE.split(",") if name.strip()]
    if not level_names:
        print("No action taken. Set LEVELS_TO_REMOVE to a comma-separated list of moon/level names.")
        return

    removed_count, not_found = remove_levels(SOURCE_CFG_PATH, OUTPUT_CFG_PATH, level_names)
    print(f"Wrote {OUTPUT_CFG_PATH.name} with {removed_count} section(s) removed.")
    if not_found:
        print(f"Warning: no matching section found for: {', '.join(not_found)}")


if __name__ == "__main__":
    main()
