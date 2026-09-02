"""
copied_lethallevelloader.cfg dungeon odds tool.

Prints, for every moon/level, the relative probability of each interior/
dungeon being chosen for it based on the current settings in
copied_lethallevelloader.cfg.

How to use:
    Run this script: python dungeon_odds_tool.py
    Each run overwrites dungeon_interior_weights.csv with the latest results -
    one row per level/moon, one column per dungeon, values are the percentage
    chance of that dungeon being chosen (open it with the Rainbow CSV
    extension to line the columns up).

What is (and isn't) accounted for:
    - "Manual Level Names List" on each dungeon: always applied.
    - "Dynamic Level Tags List" on each dungeon: applied only if the global
      "Inject Dynamic Matching Weights" setting is true. Since a level's own
      tags aren't stored in this cfg, every level is assumed to only carry
      the automatic "Vanilla" tag (vanilla levels) or "Custom"/"Modded" tags
      (custom levels) - any extra tags a mod author assigned aren't visible
      here and are NOT accounted for.
    - "Manual Mod Names List" and "Dynamic Route Price List" are NOT
      accounted for, since a level's owning mod name and true route price
      aren't stored in this cfg either.
    - A dungeon's settings are only used if its own "Enable Content
      Configuration" is true; otherwise its listed "# Default value" is used
      instead, matching how LethalLevelLoader actually reads the cfg.

This is a best-effort approximation, not a byte-for-byte reproduction of
LethalLevelLoader's internal weighting algorithm.
"""

from __future__ import annotations

import csv
import re
from pathlib import Path

SOURCE_CFG_PATH = Path(__file__).resolve().parent / "copied_lethallevelloader.cfg"
OUTPUT_CSV_PATH = SOURCE_CFG_PATH.with_name("dungeon_interior_weights.csv")

ZERO_WIDTH_SPACE = "\u200b"
SECTION_HEADER_RE = re.compile(r"^\[(?P<inner>.*)\]\s*$")
LEADING_NUMBER_RE = re.compile(r"^\d+\s+")
SETTING_LINE_RE = re.compile(r"^(?P<key>.+?) = (?P<value>.*)$")
DEFAULT_COMMENT_RE = re.compile(r"^# Default value:\s?(?P<default>.*)$")
PAIR_RE = re.compile(r"^(?P<name>.+):(?P<weight>-?\d+(?:\.\d+)?)$")


class Section:
    def __init__(self, category: str, name: str):
        self.category = category
        self.name = name
        self.fields: dict[str, tuple[str, str]] = {}  # key -> (current, default)

    def current(self, key: str, fallback: str = "") -> str:
        value, _ = self.fields.get(key, (fallback, fallback))
        return value

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


def parse_weight_pairs(raw: str) -> dict[str, float]:
    """Parse a "Name:Weight,Name2:Weight2" list into a dict. Unparseable
    entries (e.g. "Default Values Were Empty") are silently skipped."""
    weights: dict[str, float] = {}
    for chunk in raw.split(","):
        match = PAIR_RE.match(chunk.strip())
        if match:
            weights[match.group("name").strip()] = float(match.group("weight"))
    return weights


def level_tags(category: str) -> set[str]:
    if category.startswith("Vanilla"):
        return {"Vanilla"}
    return {"Custom", "Modded"}


def compute_odds(level: Section, dungeons: list[Section], inject_dynamic_weights: bool) -> dict[str, float]:
    """Return {dungeon_name: percentage} for a single level, based on each
    dungeon's weight for that level. Dungeons with zero weight are omitted."""
    tags = level_tags(level.category)
    weights: dict[str, float] = {}

    for dungeon in dungeons:
        manual_levels = parse_weight_pairs(
            dungeon.effective("Dungeon Injection Settings - Manual Level Names List")
        )
        weight = manual_levels.get(level.name, 0.0)

        if inject_dynamic_weights:
            tag_weights = parse_weight_pairs(
                dungeon.effective("Dungeon Injection Settings - Dynamic Level Tags List")
            )
            weight += sum(tag_weights.get(tag, 0.0) for tag in tags)

        if weight > 0:
            weights[dungeon.name] = weight

    total = sum(weights.values())
    if total <= 0:
        return {}
    return {name: weight / total * 100 for name, weight in weights.items()}


def main() -> None:
    if not SOURCE_CFG_PATH.exists():
        raise FileNotFoundError(f"Could not find config file at {SOURCE_CFG_PATH}")

    sections = parse_sections(SOURCE_CFG_PATH)

    settings_section = next(
        (s for s in sections if s.category.strip(" -") == "LethalLevelLoader Settings"), None
    )
    inject_dynamic_weights = True
    if settings_section is not None:
        inject_dynamic_weights = (
            settings_section.current("Inject Dynamic Matching Weights", "true").strip().lower()
            == "true"
        )

    dungeons = [s for s in sections if s.category in ("Custom Dungeon", "Vanilla Dungeon")]
    levels = [s for s in sections if s.category in ("Custom Level", "Vanilla Level")]

    print("Dungeon odds per level/moon (based on current copied_lethallevelloader.cfg contents)")
    print(
        f"Dynamic (tag-based) weight injection is "
        f"{'ENABLED' if inject_dynamic_weights else 'DISABLED'} globally."
    )
    print()

    per_level_odds: dict[str, dict[str, float]] = {}

    for level in levels:
        odds = compute_odds(level, dungeons, inject_dynamic_weights)
        per_level_odds[level.name] = odds

        print(f"{level.category}: {level.name}")
        if not odds:
            print("  No matching dungeon data found in this cfg for this level.")
        else:
            for name, percentage in sorted(odds.items(), key=lambda item: item[1], reverse=True):
                print(f"  {name}: {percentage:.2f}%")
        print()

    write_csv(OUTPUT_CSV_PATH, levels, dungeons, per_level_odds)
    print(f"Wrote {OUTPUT_CSV_PATH.name}")


def write_csv(
    path: Path,
    levels: list[Section],
    dungeons: list[Section],
    per_level_odds: dict[str, dict[str, float]],
) -> None:
    """Write one row per level/moon, one column per dungeon, with each cell
    holding that dungeon's percentage chance for that level (0 if none)."""
    dungeon_names = [dungeon.name for dungeon in dungeons]

    with path.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(["Level"] + dungeon_names)
        for level in levels:
            odds = per_level_odds.get(level.name, {})
            row = [level.name] + [f"{odds.get(name, 0.0):.2f}" for name in dungeon_names]
            writer.writerow(row)


if __name__ == "__main__":
    main()
