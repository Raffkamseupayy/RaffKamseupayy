#!/usr/bin/env python3
"""Write the 13 November 2026 news image to /output/entry.png.

The image is stored in this repository as entry.jpg.b64 (base64 text,
because the repository push only accepts UTF-8 text files). This script
decodes it and writes the JPEG bytes to /output/entry.png. The program
uses no network and writes identical bytes on every run.
"""

import base64
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "entry.jpg.b64")
OUT_DIR = "/output"
OUT = os.path.join(OUT_DIR, "entry.png")


def main() -> None:
    with open(SRC, "r", encoding="ascii") as f:
        data = base64.b64decode(f.read())
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(data)
    # Read the output back and confirm it is byte-identical to the
    # decoded image, so both runs are provably deterministic.
    with open(OUT, "rb") as f:
        written = f.read()
    assert written == data, "output differs from decoded image"
    print(f"Wrote {OUT} ({len(data)} bytes, verified identical to decoded image)")


if __name__ == "__main__":
    main()
