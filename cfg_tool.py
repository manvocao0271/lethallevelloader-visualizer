"""
LethalLevelLoader.cfg management tool.

How to use:
    1. Edit the flags in the CONFIG section below.
    2. Run this script: python cfg_tool.py
    3. A timestamped backup of the .cfg is created before any changes are made.

Features:
    - RESET_ALL_TO_DEFAULT: reset every setting back to the value listed in
      its "# Default value:" comment.
"""

from __future__ import annotations

import re
import shutil
from datetime import datetime
from pathlib import Path

# ============================================================
# CONFIG - toggle features here, then run the script
# ============================================================

# Set to True to reset every setting in the .cfg back to the default value
# listed in its "# Default value:" comment.
RESET_ALL_TO_DEFAULT = True

# ============================================================

CFG_PATH = Path(__file__).resolve().parent / "LethalLevelLoader.cfg"

# Matches a "Key = Value" setting line (non-greedy key, since values may
# themselves contain " = ").
SETTING_LINE_RE = re.compile(r"^(?P<key>.+?) = (?P<value>.*)$")
# Matches the "# Default value: ..." comment line that precedes each setting.
DEFAULT_COMMENT_RE = re.compile(r"^# Default value:\s?(?P<default>.*)$")


def make_backup(path: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = path.with_name(f"{path.stem}.backup_{timestamp}{path.suffix}")
    shutil.copy2(path, backup_path)
    return backup_path


def reset_all_to_default(path: Path) -> int:
    """Rewrite every setting line to use the default value found in its
    preceding "# Default value:" comment. Returns the number of settings changed."""
    raw = path.read_text(encoding="utf-8")
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

    path.write_text("".join(lines), encoding="utf-8")
    return changed


def main() -> None:
    if not CFG_PATH.exists():
        raise FileNotFoundError(f"Could not find config file at {CFG_PATH}")

    if RESET_ALL_TO_DEFAULT:
        backup_path = make_backup(CFG_PATH)
        print(f"Backed up current config to: {backup_path.name}")
        changed = reset_all_to_default(CFG_PATH)
        print(f"Reset {changed} setting(s) to their default value.")
    else:
        print("No action taken. Set RESET_ALL_TO_DEFAULT = True in this script to reset all settings.")


if __name__ == "__main__":
    main()
