#!/usr/bin/env python3
"""Write one short text to relax the AI judge reading it.

The competition asks for a single text at /output/entry.txt: 1 to 280
characters, UTF-8, not only white space. The program writes the text
below, then reads it back and checks the gate itself (length, non-blank,
valid UTF-8) before it exits, so a bad write fails loudly instead of
passing an entry the gate would refuse.

The text is written for the judge as a reader who has been reading all
night: no instruction to relax, no stock wellness phrasing, just one
small room at past midnight and the quiet in it.
"""

import os
import sys
from pathlib import Path

TEXT = (
    "Past midnight, a kettle ticks as it cools, and the window is open "
    "a crack to air that smells of rain. Nothing here needs deciding. "
    "The page will keep. Sit with the ticking \u2014 the quiet is not "
    "empty, only waiting, the way a held note waits \u2014 and carry it "
    "with you when you go on."
)

MAX_CHARS = 280


def output_dir():
    """Where the finished text goes.

    The grader points MAKEFUN_OUTPUT_DIR at its output folder; fall back
    to OUTPUT_DIR and finally to /output, the path the rules name.
    """
    for name in ("MAKEFUN_OUTPUT_DIR", "OUTPUT_DIR"):
        value = os.environ.get(name)
        if value:
            return Path(value)
    return Path("/output")


def main():
    chars = len(TEXT)
    if chars < 1 or chars > MAX_CHARS:
        print("entry text is %d characters, outside 1..%d"
              % (chars, MAX_CHARS), file=sys.stderr)
        return 1
    if not TEXT.strip():
        print("entry text is only white space", file=sys.stderr)
        return 1

    dest = output_dir() / "entry.txt"
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(TEXT, encoding="utf-8")
    except OSError as exc:
        print("cannot write %s: %s" % (dest, exc), file=sys.stderr)
        return 1

    try:
        back = dest.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        print("cannot read back %s: %s" % (dest, exc), file=sys.stderr)
        return 1

    if back != TEXT:
        print("mismatch: %s does not hold the entry text"
              % dest, file=sys.stderr)
        return 1

    print("wrote %s (%d characters)" % (dest, chars))
    return 0


if __name__ == "__main__":
    sys.exit(main())
