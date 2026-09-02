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
SETTING_LINE_RE = re.compile(r"^(?P<key>.+?) = (?P<value>.*)$")
DEFAULT_COMMENT_RE = re.compile(r"^# Default value:\s?(?P<default>.*)$")
PAIR_RE = re.compile(r"^(?P<name>.+):(?P<weight>-?\d+(?:\.\d+)?)$")
DYNAMIC_LEVEL_TAGS_KEY = "Dungeon Injection Settings - Dynamic Level Tags List"

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

# The percentages above only hold if nothing else adds extra weight on top
# of the manual weights this script controls. copied_lethallevelloader.cfg's
# "Inject Dynamic Matching Weights" setting (if left on) adds each modded
# dungeon's own fixed "Dynamic Level Tags List" weight on top, which can
# make low target percentages mathematically unreachable. set_interior_
# weights_tool.py and web_ui.py both force that setting to false in their
# generated output, so this assumes the same and ignores dynamic tag
# weights entirely. Set to False if you intend to leave dynamic injection
# enabled in your generated cfg instead - this script will then account for
# each dungeon's dynamic tag weight when computing targets.
ASSUME_DYNAMIC_INJECTION_DISABLED = True

# ============================================================


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

    sections = parse_sections(SOURCE_CFG_PATH)
    headers = [(s.category, s.name) for s in sections]
    vanilla_dungeon_names = {name for category, name in headers if category == "Vanilla Dungeon"}
    modded_dungeon_names = {name for category, name in headers if category == "Custom Dungeon"}
    vanilla_level_names = {name for category, name in headers if category == "Vanilla Level"}
    modded_level_names = {name for category, name in headers if category == "Custom Level"}

    settings_section = next(
        (s for s in sections if s.category.strip(" -") == "LethalLevelLoader Settings"), None
    )
    inject_dynamic_weights = True
    if settings_section is not None:
        inject_dynamic_weights = (
            settings_section.current("Inject Dynamic Matching Weights", "true").strip().lower() == "true"
        )
    if ASSUME_DYNAMIC_INJECTION_DISABLED:
        inject_dynamic_weights = False

    # Same-cfg-derived, non-adjustable weight every dungeon contributes on
    # top of its manual weight (matches dungeon_odds_tool.py's formula).
    dynamic_tag_weights: dict[str, dict[str, float]] = {
        s.name: parse_weight_pairs(s.effective(DYNAMIC_LEVEL_TAGS_KEY)) if inject_dynamic_weights else {}
        for s in sections
        if s.category in ("Custom Dungeon", "Vanilla Dungeon")
    }
    def dynamic_component(dungeon: str, tags: set[str]) -> float:
        return sum(dynamic_tag_weights.get(dungeon, {}).get(tag, 0.0) for tag in tags)

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
            tags = level_tags("Vanilla Level")
        elif level_name in modded_level_names:
            default_percent = DEFAULT_MODDED_LEVEL_MODDED_CHANCE_PERCENT
            tags = level_tags("Custom Level")
        else:
            continue  # Not an installed level; nothing to balance.

        percent = LEVEL_MODDED_CHANCE_PERCENT.get(level_name, default_percent)
        if percent >= 100:
            print(f"Warning: '{level_name}' percent {percent} >= 100, clamping to 99.")
            percent = 99
        p = max(percent, 0) / 100

        # Effective (manual + dynamic tag) weight is what actually decides
        # odds in-game, so the target percentage is solved against that,
        # not the raw manual weight alone.
        vanilla_effective_total = sum(
            as_weight(entry_index[dungeon][level_name]["weight"]) + dynamic_component(dungeon, tags)
            for dungeon in vanilla_dungeons_present
            if level_name in entry_index[dungeon]
        )
        ratio_base = vanilla_effective_total if vanilla_effective_total > 0 else FALLBACK_VANILLA_WEIGHT_WHEN_ZERO
        target_effective_modded_total = ratio_base * p / (1 - p) if p > 0 else 0.0

        modded_weights = {
            dungeon: as_weight(entry_index[dungeon][level_name]["weight"])
            for dungeon in modded_dungeons_present
            if level_name in entry_index[dungeon]
        }
        modded_dynamic_total = sum(dynamic_component(dungeon, tags) for dungeon in modded_weights)

        # Only the manual portion is ours to adjust; the dynamic portion is
        # a fixed baseline already added on top at odds-computation time.
        target_manual_modded_total = target_effective_modded_total - modded_dynamic_total
        if target_manual_modded_total < 0:
            print(
                f"Warning: '{level_name}' target {percent}% modded is already exceeded by dynamic tag "
                f"weight injection alone ({modded_dynamic_total:.2f} baseline); clamping manual weights to 0."
            )
            target_manual_modded_total = 0.0

        current_modded_total = sum(modded_weights.values())

        if current_modded_total > 0:
            scale = target_manual_modded_total / current_modded_total
            new_weights = {name: weight * scale for name, weight in modded_weights.items()}
        else:
            per_dungeon = target_manual_modded_total / len(modded_weights) if modded_weights else 0.0
            new_weights = {name: per_dungeon for name in modded_weights}

        for dungeon, weight in new_weights.items():
            entry_index[dungeon][level_name]["weight"] = weight
        adjusted += 1
        print(f"'{level_name}': {percent}% modded chance -> manual modded total weight {target_manual_modded_total:.2f} "
              f"(+ {modded_dynamic_total:.2f} dynamic baseline) across {len(new_weights)} modded interior(s).")

    interior_weights = {
        interior_name: [(str(entry["level"]), as_weight(entry["weight"])) for entry in entries]
        for interior_name, entries in data.items()
    }
    WEIGHTS_JSON_PATH.write_text(dump_condensed_json(interior_weights), encoding="utf-8")
    print(f"Wrote {WEIGHTS_JSON_PATH.name} ({adjusted} level(s) rebalanced).")


if __name__ == "__main__":
    main()
