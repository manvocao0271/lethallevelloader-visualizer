"""
interior_weights.json balancer.

Rebalances the "modded dungeon" (Custom Dungeon) weights for each level in
interior_weights.json so that, overall, each level has a specific target
percent chance of landing in ANY modded interior, while its weights across
the "vanilla dungeons" (Facility, Haunted Mansion, Mineshaft - the 3
"Vanilla Dungeon" sections in the cfg) are left untouched.

How to use:
    1. Edit LEVEL_MODDED_CHANCE_PERCENT / the two DEFAULT_* constants below
       to whatever percentages you want.
    2. Run this script: python balance_interior_weights.py
    3. interior_weights.json is overwritten in place with the rebalanced
       weights (same convention as read_interior_weights_tool.py - this is a
       regenerated data file, not the source .cfg).
    4. Run set_interior_weights_tool.py afterwards to apply the result to a
       new .cfg file.

For a level with an existing nonzero total modded-dungeon weight, that
weight is proportionally rescaled across the modded dungeons to hit the
target total, preserving whatever relative preference already existed
between modded interiors. If a level currently has zero weight in every
modded dungeon, the target total is split evenly across them instead.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

SOURCE_CFG_PATH = Path(__file__).resolve().parent / "copied_lethallevelloader.cfg"
WEIGHTS_JSON_PATH = Path(__file__).resolve().parent / "interior_weights.json"

ZERO_WIDTH_SPACE = "\u200b"
SECTION_HEADER_RE = re.compile(r"^\[(?P<inner>.*)\]\s*$")
LEADING_NUMBER_RE = re.compile(r"^\d+\s+")

# ============================================================
# CONFIG - edit percentages here, then run the script
# ============================================================

# Percent chance (0-100) of landing in ANY modded interior, per level name.
# Any vanilla level not listed here falls back to
# DEFAULT_VANILLA_LEVEL_MODDED_CHANCE_PERCENT; any modded/custom level not
# listed here falls back to DEFAULT_MODDED_LEVEL_MODDED_CHANCE_PERCENT.
LEVEL_MODDED_CHANCE_PERCENT: dict[str, float] = {
    "Experimentation": 5,
    "Assurance": 5,
    "Vow": 5,
    "March": 10,
    "Adamance": 10,
    "Offense": 10,
    "Embrion": 15,
    "Rend": 15,
    "Dine": 15,
    "Titan": 15,
    "Artifice": 20,
}

# Vanilla levels not listed above (e.g. Gordion, Liquidation) get this
# percent instead - 0 means "only ever use the vanilla dungeon weights".
DEFAULT_VANILLA_LEVEL_MODDED_CHANCE_PERCENT = 0

# Modded/custom levels not listed above get this percent instead.
DEFAULT_MODDED_LEVEL_MODDED_CHANCE_PERCENT = 50

# Nominal vanilla-dungeon weight total to use when a level's actual weight
# is 0 across all vanilla dungeons (so its target percent is still
# well-defined instead of dividing by zero).
FALLBACK_VANILLA_WEIGHT_WHEN_ZERO = 100

# ============================================================


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


def parse_section_headers(path: Path) -> list[tuple[str, str]]:
    """Return (category, name) for every section header in the cfg."""
    headers = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if SECTION_HEADER_RE.match(line):
            headers.append(parse_header(line))
    return headers


def to_json_number(weight: float):
    return int(weight) if weight.is_integer() else round(weight, 2)


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


def as_weight(value: object) -> float:
    """JSON numbers deserialize as int or float; this covers both while
    giving the type checker a real float instead of `object`."""
    assert isinstance(value, (int, float))
    return float(value)


def main() -> None:
    if not SOURCE_CFG_PATH.exists():
        raise FileNotFoundError(f"Could not find config file at {SOURCE_CFG_PATH}")
    if not WEIGHTS_JSON_PATH.exists():
        raise FileNotFoundError(f"Could not find weights JSON file at {WEIGHTS_JSON_PATH}")

    headers = parse_section_headers(SOURCE_CFG_PATH)
    vanilla_dungeon_names = {name for category, name in headers if category == "Vanilla Dungeon"}
    modded_dungeon_names = {name for category, name in headers if category == "Custom Dungeon"}
    vanilla_level_names = {name for category, name in headers if category == "Vanilla Level"}
    modded_level_names = {name for category, name in headers if category == "Custom Level"}

    data: dict[str, list[dict[str, object]]] = json.loads(WEIGHTS_JSON_PATH.read_text(encoding="utf-8"))

    vanilla_dungeons_present = [name for name in data if name in vanilla_dungeon_names]
    modded_dungeons_present = [name for name in data if name in modded_dungeon_names]
    unknown_interiors = [name for name in data if name not in vanilla_dungeon_names and name not in modded_dungeon_names]
    if unknown_interiors:
        print(f"Warning: skipping interior(s) not found as a dungeon section in the cfg: {', '.join(unknown_interiors)}")

    # Index each interior's entries by level name for quick lookup/updates.
    entry_index: dict[str, dict[str, dict[str, object]]] = {
        interior_name: {str(entry["level"]): entry for entry in entries}
        for interior_name, entries in data.items()
    }

    all_levels = list(next(iter(entry_index.values())).keys()) if entry_index else []

    adjusted = 0
    for level_name in all_levels:
        if level_name in vanilla_level_names:
            default_percent = DEFAULT_VANILLA_LEVEL_MODDED_CHANCE_PERCENT
        elif level_name in modded_level_names:
            default_percent = DEFAULT_MODDED_LEVEL_MODDED_CHANCE_PERCENT
        else:
            continue  # Not an installed level; nothing to balance.

        percent = LEVEL_MODDED_CHANCE_PERCENT.get(level_name, default_percent)
        if percent >= 100:
            print(f"Warning: '{level_name}' percent {percent} >= 100, clamping to 99.")
            percent = 99
        p = max(percent, 0) / 100

        vanilla_total = sum(
            as_weight(entry_index[dungeon][level_name]["weight"])
            for dungeon in vanilla_dungeons_present
            if level_name in entry_index[dungeon]
        )
        ratio_base = vanilla_total if vanilla_total > 0 else FALLBACK_VANILLA_WEIGHT_WHEN_ZERO
        target_modded_total = ratio_base * p / (1 - p) if p > 0 else 0.0

        modded_weights = {
            dungeon: as_weight(entry_index[dungeon][level_name]["weight"])
            for dungeon in modded_dungeons_present
            if level_name in entry_index[dungeon]
        }
        current_modded_total = sum(modded_weights.values())

        if current_modded_total > 0:
            scale = target_modded_total / current_modded_total
            new_weights = {name: weight * scale for name, weight in modded_weights.items()}
        else:
            per_dungeon = target_modded_total / len(modded_weights) if modded_weights else 0.0
            new_weights = {name: per_dungeon for name in modded_weights}

        for dungeon, weight in new_weights.items():
            entry_index[dungeon][level_name]["weight"] = weight
        adjusted += 1
        print(f"'{level_name}': {percent}% modded chance -> modded total weight {target_modded_total:.2f} "
              f"across {len(new_weights)} modded interior(s).")

    interior_weights = {
        interior_name: [(str(entry["level"]), as_weight(entry["weight"])) for entry in entries]
        for interior_name, entries in data.items()
    }
    WEIGHTS_JSON_PATH.write_text(dump_condensed_json(interior_weights), encoding="utf-8")
    print(f"Wrote {WEIGHTS_JSON_PATH.name} ({adjusted} level(s) rebalanced).")


if __name__ == "__main__":
    main()
