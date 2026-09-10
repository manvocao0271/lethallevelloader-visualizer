"""
Interior weights web UI.

A small local web app that combines reset_tool.py, clean_cfg.py,
read_interior_weights_tool.py and set_interior_weights_tool.py into one
interactive page: edit interior_weights.json's weights in the browser, see
each level's dungeon odds recalculate live (same formula as
dungeon_odds_tool.py), then download a new .cfg with your edits applied -
optionally also resetting every setting to its default and/or removing
references to uninstalled levels first.

Note: dynamic tag weight injection ("Dungeon Injection Settings - Dynamic
Level Tags List") is always applied when computing odds, regardless of the
cfg's "Inject Dynamic Matching Weights" setting. That setting does not
actually gate dynamic tag matching in LethalLevelLoader's dungeon-selection
code (confirmed via source inspection) - it is effectively a dead/vestigial
setting, so this tool ignores it rather than mislead you into thinking it
disables anything.

How to use:
    Run this script: python web_ui.py
    It opens http://127.0.0.1:8765/ in your browser. Nothing is written to
    disk until you click "Download .cfg" - the download is generated
    on-the-fly and never overwrites copied_lethallevelloader.cfg or
    interior_weights.json.
"""

from __future__ import annotations

import json
import re
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8765

ROOT_DIR = Path(__file__).resolve().parent
WEB_DIR = ROOT_DIR / "web"
SOURCE_CFG_PATH = ROOT_DIR / "copied_lethallevelloader.cfg"
WEIGHTS_JSON_PATH = ROOT_DIR / "interior_weights.json"

ZERO_WIDTH_SPACE = "\u200b"
SECTION_HEADER_RE = re.compile(r"^\[(?P<inner>.*)\]\s*$")
LEADING_NUMBER_RE = re.compile(r"^\d+\s+")
SETTING_LINE_RE = re.compile(r"^(?P<key>.+?) = (?P<value>.*)$")
DEFAULT_COMMENT_RE = re.compile(r"^# Default value:\s?(?P<default>.*)$")
PAIR_RE = re.compile(r"^(?P<name>.+):(?P<weight>-?\d+(?:\.\d+)?)$")
# Only matches plain integers (no decimal point), mirroring C#'s
# int.TryParse - LethalLevelLoader silently treats a decimal value like
# "74.63" as if that specific entry were never listed (weight 0).
PAIR_RE_INT = re.compile(r"^(?P<name>.+):(?P<weight>-?\d+)$")
MIN_WEIGHT = 0
MAX_WEIGHT = 9999
MANUAL_LEVEL_NAMES_KEY = "Dungeon Injection Settings - Manual Level Names List"
DYNAMIC_LEVEL_TAGS_KEY = "Dungeon Injection Settings - Dynamic Level Tags List"
ENABLE_CONTENT_CONFIG_KEY = "Enable Content Configuration"

# Per-moon settings shown/edited in the web UI's "Moon Settings" panel, in
# the same order they appear in each Custom Level/Vanilla Level section.
LEVEL_SETTING_KEYS = [
    "General Settings - Planet Route Price",
    "General Settings - Day Speed Multiplier",
    "General Settings - Does Planet Have Time",
    "Scrap Settings - Minimum Scrap Item Spawns",
    "Scrap Settings - Maximum Scrap Item Spawns",
    "Scrap Settings - Minimum Total Scrap Value",
    "Scrap Settings - Maximum Total Scrap Value",
    "Enemy Settings - Maximum Inside Enemy Power Count",
    "Enemy Settings - Maximum Outside, Daytime Enemy Power Count",
    "Enemy Settings - Maximum Outside, Nighttime Enemy Power Count",
    "Enemy Settings - Inside Enemies Spawning List",
    "Enemy Settings - Outside Daytime Enemies Spawning List",
    "Enemy Settings - Outside Nighttime Enemies Spawning List",
]

# Per-interior (dungeon) size settings shown/edited in the "Interior Weights
# by Level" table, in the same order they appear in each Custom Dungeon/
# Vanilla Dungeon section.
DUNGEON_SIZE_SETTING_KEYS = [
    "General Settings - Minimum Dungeon Size Multiplier",
    "General Settings - Maximum Dungeon Size Multiplier",
    "General Settings - Restrict Dungeon Size Scaler",
]

STATIC_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}

class Section:
    def __init__(self, category: str, name: str):
        self.category = category
        self.name = name
        self.fields: dict[str, tuple[str, str]] = {}  # key -> (current, default)

    def current(self, key: str, fallback: str = "") -> str:
        value, _ = self.fields.get(key, (fallback, fallback))
        return value

    def effective(self, key: str) -> str:
        current, default = self.fields.get(key, ("", ""))
        return current if self.is_enabled() else default

    def is_enabled(self) -> bool:
        current, _ = self.fields.get(ENABLE_CONTENT_CONFIG_KEY, ("false", "false"))
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


def parse_sections_from_lines(lines: list[str]) -> list[Section]:
    sections: list[Section] = []
    pending_default = None

    for line in lines:
        stripped = line.rstrip("\r\n")
        if SECTION_HEADER_RE.match(stripped):
            category, name = parse_header(stripped)
            sections.append(Section(category, name))
            pending_default = None
            continue

        default_match = DEFAULT_COMMENT_RE.match(stripped)
        if default_match:
            pending_default = default_match.group("default")
            continue

        if not stripped or stripped.startswith("#"):
            continue

        setting_match = SETTING_LINE_RE.match(stripped)
        if setting_match and sections:
            key = setting_match.group("key")
            value = setting_match.group("value")
            default_value = pending_default if pending_default is not None else value
            sections[-1].fields[key] = (value, default_value)
        pending_default = None

    return sections


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


def parse_weight_pairs(raw: str) -> dict[str, float]:
    weights: dict[str, float] = {}
    for chunk in raw.split(","):
        match = PAIR_RE.match(chunk.strip())
        if match:
            weights[match.group("name").strip()] = float(match.group("weight"))
    return weights


def clamp_weight(value: int) -> int:
    return max(MIN_WEIGHT, min(MAX_WEIGHT, value))


def parse_int_weight_pairs(raw: str) -> dict[str, int]:
    """Parse a "Name:Weight,Name2:Weight2" list the same way
    LethalLevelLoader's ConfigHelper.ConvertToStringWithRarityList does
    (int.TryParse per entry, clamped to [0, 9999]) - used for dynamic tag
    weights, which are read-only ground truth the real game will use
    exactly as parsed here."""
    weights: dict[str, int] = {}
    for chunk in raw.split(","):
        match = PAIR_RE_INT.match(chunk.strip())
        if match:
            weights[match.group("name").strip()] = clamp_weight(int(match.group("weight")))
    return weights


def level_tags(category: str) -> list[str]:
    return ["Vanilla"] if category.startswith("Vanilla") else ["Custom", "Modded"]


# ---------------------------------------------------------------------------
# reset_tool.py logic
# ---------------------------------------------------------------------------

def reset_all_to_default(lines: list[str]) -> int:
    pending_default = None
    changed = 0

    for i, line in enumerate(lines):
        stripped = line.rstrip("\r\n")

        default_match = DEFAULT_COMMENT_RE.match(stripped)
        if default_match:
            pending_default = default_match.group("default")
            continue

        if not stripped or stripped.startswith("#") or stripped.startswith("["):
            continue

        setting_match = SETTING_LINE_RE.match(stripped)
        if setting_match and pending_default is not None:
            key = setting_match.group("key")
            current_value = setting_match.group("value")
            if current_value != pending_default:
                line_ending = line[len(stripped):]
                lines[i] = f"{key} = {pending_default}{line_ending}"
                changed += 1
        pending_default = None

    return changed


# ---------------------------------------------------------------------------
# clean_cfg.py logic
# ---------------------------------------------------------------------------

def remove_uninstalled_level_references(lines: list[str], sections: list[tuple[str, str, int, int]]) -> int:
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


# ---------------------------------------------------------------------------
# set_interior_weights_tool.py logic
# ---------------------------------------------------------------------------

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


def as_weight(value: object) -> float:
    assert isinstance(value, (int, float)), f"Expected a number, got {value!r}"
    return float(value)


def format_weight(weight: float) -> str:
    """LethalLevelLoader parses each weight with C#'s int.TryParse and
    clamps it to [0, 9999] (ConfigHelper.ConvertToStringWithRarityList) - a
    decimal value would silently fail to parse and become 0 in-game, so
    always write a plain, rounded, clamped integer here regardless of what
    the client computed."""
    return str(clamp_weight(round(weight)))


def apply_weight_updates(lines: list[str], start: int, end: int, updates: dict[str, float]) -> None:
    pairs = [[name, weight] for name, weight in updates.items()]
    new_value = ",".join(f"{name}:{format_weight(weight)}" for name, weight in pairs)
    set_field(lines, start, end, MANUAL_LEVEL_NAMES_KEY, new_value)

    enabled = (get_field(lines, start, end, ENABLE_CONTENT_CONFIG_KEY) or "").strip().lower()
    if enabled != "true":
        set_field(lines, start, end, ENABLE_CONTENT_CONFIG_KEY, "true")


def apply_level_setting_updates(lines: list[str], start: int, end: int, updates: dict[str, str]) -> None:
    for key, value in updates.items():
        if key not in LEVEL_SETTING_KEYS:
            continue
        set_field(lines, start, end, key, str(value))

    enabled = (get_field(lines, start, end, ENABLE_CONTENT_CONFIG_KEY) or "").strip().lower()
    if enabled != "true":
        set_field(lines, start, end, ENABLE_CONTENT_CONFIG_KEY, "true")


def apply_dungeon_size_setting_updates(lines: list[str], start: int, end: int, updates: dict[str, str]) -> None:
    for key, value in updates.items():
        if key not in DUNGEON_SIZE_SETTING_KEYS:
            continue
        set_field(lines, start, end, key, str(value))

    enabled = (get_field(lines, start, end, ENABLE_CONTENT_CONFIG_KEY) or "").strip().lower()
    if enabled != "true":
        set_field(lines, start, end, ENABLE_CONTENT_CONFIG_KEY, "true")


# ---------------------------------------------------------------------------
# API handlers
# ---------------------------------------------------------------------------

def build_data_payload() -> dict[str, object]:
    lines = SOURCE_CFG_PATH.read_text(encoding="utf-8").splitlines()
    sections = parse_sections_from_lines(lines)

    level_sections = [s for s in sections if s.category in ("Custom Level", "Vanilla Level")]
    dungeon_sections = [s for s in sections if s.category in ("Custom Dungeon", "Vanilla Dungeon")]
    level_category_by_name = {s.name: s.category for s in level_sections}

    dungeons_payload = []
    for dungeon in dungeon_sections:
        tag_weights = parse_int_weight_pairs(dungeon.effective(DYNAMIC_LEVEL_TAGS_KEY))
        size_settings = {key: dungeon.effective(key) for key in DUNGEON_SIZE_SETTING_KEYS}
        size_settings_defaults = {
            key: dungeon.fields.get(key, ("", ""))[1] for key in DUNGEON_SIZE_SETTING_KEYS
        }
        dungeons_payload.append({
            "name": dungeon.name,
            "category": dungeon.category,
            "dynamicTagWeights": tag_weights,
            "sizeSettings": size_settings,
            "sizeSettingsDefaults": size_settings_defaults,
        })

    weights = json.loads(WEIGHTS_JSON_PATH.read_text(encoding="utf-8")) if WEIGHTS_JSON_PATH.exists() else {}

    # Preserve the level row order already established in interior_weights.json.
    level_order = []
    if weights:
        level_order = [entry["level"] for entry in next(iter(weights.values()))]
    levels_payload = [
        {"name": name, "category": level_category_by_name.get(name, "")}
        for name in level_order
    ]

    # Each dungeon's documented "# Default value" for its Manual Level Names
    # List, so the "Reset to default" button can restore weights live.
    default_weights_payload: dict[str, list[dict[str, object]]] = {}
    for dungeon in dungeon_sections:
        default_raw = dungeon.fields.get(MANUAL_LEVEL_NAMES_KEY, ("", ""))[1]
        default_pairs = parse_weight_pairs(default_raw)
        default_weights_payload[dungeon.name] = [
            {"level": name, "weight": default_pairs.get(name, 0.0)} for name in level_order
        ]

    level_by_name = {s.name: s for s in level_sections}
    level_settings_payload: dict[str, dict[str, str]] = {
        name: {key: level_by_name[name].effective(key) for key in LEVEL_SETTING_KEYS}
        for name in level_order
        if name in level_by_name
    }
    level_settings_defaults_payload: dict[str, dict[str, str]] = {
        name: {key: level_by_name[name].fields.get(key, ("", ""))[1] for key in LEVEL_SETTING_KEYS}
        for name in level_order
        if name in level_by_name
    }

    return {
        "levels": levels_payload,
        "dungeons": dungeons_payload,
        "weights": weights,
        "defaultWeights": default_weights_payload,
        "levelSettings": level_settings_payload,
        "levelSettingsDefaults": level_settings_defaults_payload,
    }


def build_download_cfg(
    reset_to_default: bool,
    clean_references: bool,
    empty_dungeon_injections: bool,
    weights: dict[str, list[dict[str, object]]],
    level_settings: dict[str, dict[str, str]],
    dungeon_size_settings: dict[str, dict[str, str]],
) -> str:
    lines = SOURCE_CFG_PATH.read_text(encoding="utf-8").splitlines(keepends=True)

    if reset_to_default:
        reset_all_to_default(lines)

    sections = find_sections(lines)

    if clean_references:
        remove_uninstalled_level_references(lines, sections)

    dungeon_by_name = {
        name.lower(): (start, end)
        for category, name, start, end in sections
        if category in ("Custom Dungeon", "Vanilla Dungeon")
    }
    level_by_name = {
        name: (start, end)
        for category, name, start, end in sections
        if category in ("Custom Level", "Vanilla Level")
    }

    if empty_dungeon_injections:
        for start, end in dungeon_by_name.values():
            set_field(lines, start, end, DYNAMIC_LEVEL_TAGS_KEY, "Default Values Were Empty")

    for interior_name, entries in weights.items():
        match = dungeon_by_name.get(interior_name.strip().lower())
        if match is None:
            continue
        start, end = match
        updates = {str(entry["level"]).strip(): as_weight(entry["weight"]) for entry in entries}
        apply_weight_updates(lines, start, end, updates)

    for level_name, updates in level_settings.items():
        match = level_by_name.get(level_name.strip())
        if match is None:
            continue
        start, end = match
        apply_level_setting_updates(lines, start, end, updates)

    for dungeon_name, updates in dungeon_size_settings.items():
        match = dungeon_by_name.get(dungeon_name.strip().lower())
        if match is None:
            continue
        start, end = match
        apply_dungeon_size_setting_updates(lines, start, end, updates)

    return "".join(lines)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass  # Keep the terminal quiet; errors still raise/print via default handling.

    def _send_json(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, rel_path: str) -> None:
        file_path = (WEB_DIR / rel_path).resolve()
        if WEB_DIR not in file_path.parents or not file_path.is_file():
            self.send_error(404, "Not found")
            return
        content_type = STATIC_CONTENT_TYPES.get(file_path.suffix, "application/octet-stream")
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/" or self.path == "":
            self._send_static("index.html")
        elif self.path == "/api/data":
            try:
                self._send_json(build_data_payload())
            except Exception as exc:  # noqa: BLE001 - surface any error to the browser
                self._send_json({"error": str(exc)}, status=500)
        elif self.path.startswith("/"):
            self._send_static(self.path.lstrip("/"))
        else:
            self.send_error(404, "Not found")

    def do_POST(self) -> None:
        if self.path != "/api/download":
            self.send_error(404, "Not found")
            return

        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            cfg_text = build_download_cfg(
                bool(body.get("resetToDefault")),
                bool(body.get("cleanReferences")),
                bool(body.get("emptyDungeonInjections")),
                body.get("weights") or {},
                body.get("levelSettings") or {},
                body.get("dungeonSizeSettings") or {},
            )
        except Exception as exc:  # noqa: BLE001 - surface any error to the browser
            self._send_json({"error": str(exc)}, status=400)
            return

        body_bytes = cfg_text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="LethalLevelLoader.custom.cfg"')
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)


def main() -> None:
    if not SOURCE_CFG_PATH.exists():
        raise FileNotFoundError(f"Could not find config file at {SOURCE_CFG_PATH}")
    if not WEIGHTS_JSON_PATH.exists():
        raise FileNotFoundError(
            f"Could not find {WEIGHTS_JSON_PATH.name}. Run read_interior_weights_tool.py first."
        )

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"Serving interior weights UI at {url} (Ctrl+C to stop)")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
