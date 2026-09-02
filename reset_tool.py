"""
copied_lethallevelloader.cfg reset tool.

Resets every setting in the cfg back to the value listed in its
"# Default value:" comment.

How to use:
    Run this script: python reset_tool.py
    The original copied_lethallevelloader.cfg is never modified - the result
    is written to a new file instead (see OUTPUT_CFG_PATH).
"""

from __future__ import annotations

import re
from pathlib import Path

SOURCE_CFG_PATH = Path(__file__).resolve().parent / "copied_lethallevelloader.cfg"
OUTPUT_CFG_PATH = SOURCE_CFG_PATH.with_name("LethalLevelLoader.reset.cfg")

# Matches a "Key = Value" setting line (non-greedy key, since values may
# themselves contain " = ").
SETTING_LINE_RE = re.compile(r"^(?P<key>.+?) = (?P<value>.*)$")
# Matches the "# Default value: ..." comment line that precedes each setting.
DEFAULT_COMMENT_RE = re.compile(r"^# Default value:\s?(?P<default>.*)$")


def reset_all_to_default(lines: list[str]) -> int:
    """Reset every setting line in-place to the default value found in its
    preceding "# Default value:" comment. Returns the number of settings changed."""
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

    return changed


def main() -> None:
    if not SOURCE_CFG_PATH.exists():
        raise FileNotFoundError(f"Could not find config file at {SOURCE_CFG_PATH}")

    lines = SOURCE_CFG_PATH.read_text(encoding="utf-8").splitlines(keepends=True)

    changed = reset_all_to_default(lines)
    print(f"Reset {changed} setting(s) to their default value.")

    OUTPUT_CFG_PATH.write_text("".join(lines), encoding="utf-8")
    print(f"Wrote {OUTPUT_CFG_PATH.name}")


if __name__ == "__main__":
    main()
