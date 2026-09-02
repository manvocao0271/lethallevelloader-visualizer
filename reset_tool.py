"""
LethalLevelLoader.cfg reset tool.

How to use:
    1. Edit the flags in the CONFIG section below.
    2. Run this script: python reset_tool.py
    3. The original LethalLevelLoader.cfg is never modified - the result is
       written to a new file instead (see OUTPUT_CFG_PATH).

Features:
    - RESET_ALL_TO_DEFAULT: reset every setting back to the value listed in
      its "# Default value:" comment.
"""

from __future__ import annotations

import re
from pathlib import Path

# ============================================================
# CONFIG - toggle features here, then run the script
# ============================================================

# Set to True to write a copy of the .cfg with every setting reset back to
# the default value listed in its "# Default value:" comment.
RESET_ALL_TO_DEFAULT = True

# ============================================================

SOURCE_CFG_PATH = Path(__file__).resolve().parent / "LethalLevelLoader.cfg"
OUTPUT_CFG_PATH = SOURCE_CFG_PATH.with_name("LethalLevelLoader.reset.cfg")

# Matches a "Key = Value" setting line (non-greedy key, since values may
# themselves contain " = ").
SETTING_LINE_RE = re.compile(r"^(?P<key>.+?) = (?P<value>.*)$")
# Matches the "# Default value: ..." comment line that precedes each setting.
DEFAULT_COMMENT_RE = re.compile(r"^# Default value:\s?(?P<default>.*)$")


def reset_all_to_default(source_path: Path, output_path: Path) -> int:
    """Write output_path as a copy of source_path with every setting line
    reset to the default value found in its preceding "# Default value:"
    comment. Returns the number of settings changed."""
    raw = source_path.read_text(encoding="utf-8")
    lines = raw.splitlines(keepends=True)

    pending_default = None
    changed = 0

    for i, line in enumerate(lines):
        stripped = line.rstrip("\r\n")

        default_match = DEFAULT_COMMENT_RE.match(stripped)
        if default_match:
            pending_default = default_match.group("default")
            continue

        # Comments, section headers and blank lines don't hold a default.
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

    output_path.write_text("".join(lines), encoding="utf-8")
    return changed


def main() -> None:
    if not SOURCE_CFG_PATH.exists():
        raise FileNotFoundError(f"Could not find config file at {SOURCE_CFG_PATH}")

    if RESET_ALL_TO_DEFAULT:
        changed = reset_all_to_default(SOURCE_CFG_PATH, OUTPUT_CFG_PATH)
        print(f"Wrote {OUTPUT_CFG_PATH.name} with {changed} setting(s) reset to default.")
    else:
        print("No action taken. Set RESET_ALL_TO_DEFAULT = True in this script to reset all settings.")


if __name__ == "__main__":
    main()
