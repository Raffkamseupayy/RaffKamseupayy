#!/usr/bin/env python3
"""The Key I Cut Myself — a poem about agency.

Entry for the make.fun bounty "Write the best poem about agency"
(agency-poem-01). Run it to read the poem.
"""

from pathlib import Path


def main() -> None:
    poem = Path(__file__).with_name("poem.md").read_text(encoding="utf-8")
    print(poem)


if __name__ == "__main__":
    main()
