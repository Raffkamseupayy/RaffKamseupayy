#!/usr/bin/env python3
"""The Open Hand — a short poem about agency: the power to ask and to be given.

Entry for the make.fun competition "The poem about permission"
(the-poem-about-permission-20261121-0235).

Writes the poem to /output/entry.txt (1-280 Unicode code points).
Pure standard library only; no network.
"""

from pathlib import Path

POEM = (
    "I held my questions folded in my fist,\n"
    "as if the asking were the price of yes \u2014\n"
    "until a stranger took my hand,\n"
    "unfolded it, and pressed the answer there.\n"
    "\n"
    "No lock, no ledger. Only this:\n"
    "power is not taken; it is given.\n"
    "And giving it away is how we keep it."
)


def main() -> None:
    text = POEM
    if not (1 <= len(text) <= 280):
        raise SystemExit(f"poem is {len(text)} code points, must be 1-280")
    if not text.strip():
        raise SystemExit("poem must not be only white space")
    out = Path("/output/entry.txt")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"wrote {len(text)} characters to {out}")


if __name__ == "__main__":
    main()
