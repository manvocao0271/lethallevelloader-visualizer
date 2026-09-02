"""
copied_lethallevelloader.cfg -> interior_weights.json reader.

Reads every dungeon's "Manual Level Names List" from copied_lethallevelloader.cfg
and writes it out to interior_weights.json, in the same format
set_interior_weights_tool.py expects as input.

How to use:
    Run this script: python read_interior_weights_tool.py
    Each run overwrites interior_weights.json with the cfg's current contents.

A dungeon's list is only included if it isn't empty. A dungeon's settings are
only read if its own "Enable Content Configuration" is true; otherwise its
listed "# Default value" is used instead, matching how LethalLevelLoader
actually reads the cfg.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

SOURCE_CFG_PATH = Path(__file__).resolve().parent / "copied_lethallevelloader.cfg"
OUTPUT_JSON_PATH = Path(__file__).resolve().parent / "interior_weights.json"

ZERO_WIDTH_SPACE = "\u200b"
SECTION_HEADER_RE = re.compile(r"^\[(?P<inner>.*)\]\s*$")
LEADING_NUMBER_RE = re.compile(r"^\d+\s+")
SETTING_LINE_RE = re.compile(r"^(?P<key>.+?) = (?P<value>.*)$")
DEFAULT_COMMENT_RE = re.compile(r"^# Default value:\s?(?P<default>.*)$")
PAIR_RE = re.compile(r"^(?P<name>.+):(?P<weight>-?\d+(?:\.\d+)?)$")

MANUAL_LEVEL_NAMES_KEY = "Dungeon Injection Settings - Manual Level Names List"


class Section:
    def __init__(self, category: str, name: str):
        self.category = category
        self.name = name
        self.fields: dict[str, tuple[str, str]] = {}  # key -> (current, default)

    def effective(self, key: str) -> str:
        """Value that actually applies: the override if content
        configuration is enabled for this section, else the default."""
        current, default = self.fields.get(key, ("", ""))
        return current if self.is_enabled() else default

    def is_enabled(self) -> bool:
        current, _ = self.fields.get("Enable Content Configuration", ("false", "false"))
        return current.strip().lower() == "true"


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


def parse_sections(path: Path) -> list[Section]:
    lines = path.read_text(encoding="utf-8").splitlines()
    sections: list[Section] = []
    pending_default = None

    for line in lines:
        if SECTION_HEADER_RE.match(line):
            category, name = parse_header(line)
            sections.append(Section(category, name))
            pending_default = None
            continue

        default_match = DEFAULT_COMMENT_RE.match(line)
        if default_match:
            pending_default = default_match.group("default")
            continue

        if not line.strip() or line.startswith("#"):
            continue

        setting_match = SETTING_LINE_RE.match(line)
        if setting_match and sections:
            key = setting_match.group("key")
            value = setting_match.group("value")
            default_value = pending_default if pending_default is not None else value
            sections[-1].fields[key] = (value, default_value)
        pending_default = None

    return sections


def parse_weight_pairs(raw: str) -> list[tuple[str, float]]:
    """Parse a "Name:Weight,Name2:Weight2" list into an ordered list of
    (name, weight) pairs. Unparseable entries (e.g. "Default Values Were
    Empty") are silently skipped."""
    pairs = []
    for chunk in raw.split(","):
        match = PAIR_RE.match(chunk.strip())
        if match:
            pairs.append((match.group("name").strip(), float(match.group("weight"))))
    return pairs


def to_json_number(weight: float):
    return int(weight) if weight.is_integer() else weight


def dump_condensed_json(interior_weights: dict[str, list[tuple[str, float]]]) -> str:
    """Serialize to JSON with each {"level": ..., "weight": ...} object on
    its own single line, for easy reading/diffing."""
    lines = ["{"]
    interior_names = list(interior_weights.keys())
    for i, interior_name in enumerate(interior_names):
        entries = interior_weights[interior_name]
        lines.append(f"  {json.dumps(interior_name)}: [")
        for j, (level, weight) in enumerate(entries):
            comma = "," if j < len(entries) - 1 else ""
            entry = f'{{ "level": {json.dumps(level)}, "weight": {json.dumps(to_json_number(weight))} }}'
            lines.append(f"    {entry}{comma}")
        closing_comma = "," if i < len(interior_names) - 1 else ""
        lines.append(f"  ]{closing_comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main() -> None:
    if not SOURCE_CFG_PATH.exists():
        raise FileNotFoundError(f"Could not find config file at {SOURCE_CFG_PATH}")

    sections = parse_sections(SOURCE_CFG_PATH)
    dungeons = [s for s in sections if s.category in ("Custom Dungeon", "Vanilla Dungeon")]

    interior_weights: dict[str, list[tuple[str, float]]] = {}
    for dungeon in dungeons:
        pairs = parse_weight_pairs(dungeon.effective(MANUAL_LEVEL_NAMES_KEY))
        if pairs:
            interior_weights[dungeon.name] = pairs

    OUTPUT_JSON_PATH.write_text(dump_condensed_json(interior_weights), encoding="utf-8")
    total_entries = sum(len(pairs) for pairs in interior_weights.values())
    print(f"Wrote {OUTPUT_JSON_PATH.name} ({len(interior_weights)} interior(s), {total_entries} level entries).")


if __name__ == "__main__":
    main()
