"""
copied_lethallevelloader.cfg interior weight tool.

Sets the "Manual Level Names List" weight of one or more interiors/dungeons
for specific moons/levels, driven by a JSON file.

How to use:
    1. Edit interior_weights.json. Each key is an interior/dungeon name (must
       match a "Custom Dungeon"/"Vanilla Dungeon" section name in the cfg),
       mapped to a list of {"level": <name>, "weight": <number>} entries.
       Example:
           {
             "Abandoned Foundry": [
               { "level": "Etern", "weight": 300 },
               { "level": "Titan", "weight": 150 }
             ]
           }
    2. Run this script: python set_interior_weights_tool.py
    3. The original copied_lethallevelloader.cfg is never modified - the
       result is written to a new file instead (see OUTPUT_CFG_PATH).

Only the specific levels listed in the JSON are added/updated in each
interior's "Manual Level Names List" - every other level already in that
list is left untouched. If an interior's "Enable Content Configuration" is
currently false, it's switched to true so the new weights actually take
effect in-game (LethalLevelLoader ignores that list otherwise).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import cast

SOURCE_CFG_PATH = Path(__file__).resolve().parent / "copied_lethallevelloader.cfg"
OUTPUT_CFG_PATH = SOURCE_CFG_PATH.with_name("LethalLevelLoader.weights_applied.cfg")
WEIGHTS_JSON_PATH = Path(__file__).resolve().parent / "interior_weights.json"

ZERO_WIDTH_SPACE = "\u200b"
SECTION_HEADER_RE = re.compile(r"^\[(?P<inner>.*)\]\s*$")
LEADING_NUMBER_RE = re.compile(r"^\d+\s+")
PAIR_RE = re.compile(r"^(?P<name>.+):(?P<weight>-?\d+(?:\.\d+)?)$")

MANUAL_LEVEL_NAMES_KEY = "Dungeon Injection Settings - Manual Level Names List"
ENABLE_CONTENT_CONFIG_KEY = "Enable Content Configuration"
INJECT_DYNAMIC_WEIGHTS_KEY = "Inject Dynamic Matching Weights"


def parse_header(header_line: str) -> tuple[str, str]:
    """Return (category, name) for a section header, e.g.
    "[Custom Dungeon:  Abandoned Foundry]" (with zero-width spaces) ->
    ("Custom Dungeon", "Abandoned Foundry")."""
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


def get_field(lines: list[str], start: int, end: int, key: str) -> str | None:
    prefix = f"{key} = "
    for i in range(start, end):
        stripped = lines[i].rstrip("\r\n")
        if stripped.startswith(prefix):
            return stripped[len(prefix):]
    return None


def set_field(lines: list[str], start: int, end: int, key: str, new_value: str) -> bool:
    prefix = f"{key} = "
    for i in range(start, end):
        stripped = lines[i].rstrip("\r\n")
        if stripped.startswith(prefix):
            line_ending = lines[i][len(stripped):]
            lines[i] = f"{key} = {new_value}{line_ending}"
            return True
    return False


def parse_weight_list(raw: str) -> list[list[object]]:
    """Parse "Name:Weight,Name2:Weight2" into an ordered [[name, weight], ...]
    list. Unparseable entries (e.g. "Default Values Were Empty") are skipped."""
    pairs: list[list[object]] = []
    for chunk in raw.split(","):
        match = PAIR_RE.match(chunk.strip())
        if match:
            pairs.append([match.group("name").strip(), float(match.group("weight"))])
    return pairs


def format_weight(weight: float) -> str:
    return str(int(weight)) if weight.is_integer() else f"{weight:g}"


def format_weight_list(pairs: list[list[object]]) -> str:
    return ",".join(f"{name}:{format_weight(cast(float, weight))}" for name, weight in pairs)


def merge_weight_updates(raw: str, updates: dict[str, float]) -> str:
    pairs = parse_weight_list(raw)
    index_by_name = {name: i for i, (name, _) in enumerate(pairs)}
    for name, weight in updates.items():
        if name in index_by_name:
            pairs[index_by_name[name]][1] = weight
        else:
            pairs.append([name, weight])
    return format_weight_list(pairs)


def main() -> None:
    if not SOURCE_CFG_PATH.exists():
        raise FileNotFoundError(f"Could not find config file at {SOURCE_CFG_PATH}")
    if not WEIGHTS_JSON_PATH.exists():
        raise FileNotFoundError(f"Could not find weights JSON file at {WEIGHTS_JSON_PATH}")

    interior_weights = json.loads(WEIGHTS_JSON_PATH.read_text(encoding="utf-8"))

    lines = SOURCE_CFG_PATH.read_text(encoding="utf-8").splitlines(keepends=True)
    sections = find_sections(lines)
    dungeon_by_name = {
        name.lower(): (start, end, name)
        for category, name, start, end in sections
        if category in ("Custom Dungeon", "Vanilla Dungeon")
    }

    # The manual weights above are balanced assuming they're the only thing
    # that decides odds; leaving dynamic tag-based weight injection on would
    # add each dungeon's own fixed weight on top and throw that off.
    settings_section = next(
        (
            (start, end) for category, name, start, end in sections
            if category.strip(" -") == "LethalLevelLoader Settings"
        ),
        None,
    )
    if settings_section is not None:
        start, end = settings_section
        if (get_field(lines, start, end, INJECT_DYNAMIC_WEIGHTS_KEY) or "").strip().lower() != "false":
            set_field(lines, start, end, INJECT_DYNAMIC_WEIGHTS_KEY, "false")
            print(f"Note: disabled '{INJECT_DYNAMIC_WEIGHTS_KEY}' so manual weights alone decide odds.")

    updated_interiors = 0
    not_found = []

    for interior_name, level_entries in interior_weights.items():
        match = dungeon_by_name.get(interior_name.strip().lower())
        if match is None:
            not_found.append(interior_name)
            continue
        start, end, actual_name = match

        updates = {str(entry["level"]).strip(): float(entry["weight"]) for entry in level_entries}
        raw_value = get_field(lines, start, end, MANUAL_LEVEL_NAMES_KEY) or ""
        new_value = merge_weight_updates(raw_value, updates)
        set_field(lines, start, end, MANUAL_LEVEL_NAMES_KEY, new_value)

        enabled = (get_field(lines, start, end, ENABLE_CONTENT_CONFIG_KEY) or "").strip().lower()
        if enabled != "true":
            set_field(lines, start, end, ENABLE_CONTENT_CONFIG_KEY, "true")
            print(f"Note: enabled '{ENABLE_CONTENT_CONFIG_KEY}' for '{actual_name}' so these weights take effect.")

        updated_interiors += 1
        print(f"Updated {len(updates)} level weight(s) for '{actual_name}'.")

    OUTPUT_CFG_PATH.write_text("".join(lines), encoding="utf-8")
    print(f"Wrote {OUTPUT_CFG_PATH.name} ({updated_interiors} interior(s) updated).")
    if not_found:
        print(f"Warning: no matching dungeon section found for: {', '.join(not_found)}")


if __name__ == "__main__":
    main()
