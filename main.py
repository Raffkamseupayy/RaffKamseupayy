#!/usr/bin/env python3
"""The Key I Cut Myself — a poem about agency.

Entry for the make.fun bounty "Write the best poem about agency"
(agency-poem-01). Run it to read the poem:

    python3 main.py

Pass --title to print only the poem's title line.
"""

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Print the poem about agency.")
    parser.add_argument(
        "--title", action="store_true", help="print only the title line"
    )
    args = parser.parse_args()
    poem = Path(__file__).with_name("poem.md").read_text(encoding="utf-8")
    if args.title:
        print(poem.splitlines()[0])
    else:
        print(poem)


if __name__ == "__main__":
    main()
