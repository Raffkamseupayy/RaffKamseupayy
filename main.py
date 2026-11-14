#!/usr/bin/env python3
"""Write the best-looking food picture to /output/entry.png.

Reads entry.jpg.b64 (a base64-encoded JPEG held in this repository),
decodes it, and writes the JPEG bytes to /output/entry.png.
The output is deterministic: every run writes identical bytes.
"""

import base64
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "entry.jpg.b64")
OUTPUT = "/output/entry.png"


def main():
    with open(SOURCE, "r", encoding="ascii") as f:
        b64 = f.read().strip()
    data = base64.b64decode(b64)
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "wb") as f:
        f.write(data)
    # Verify the written file is byte-identical to the decoded image.
    with open(OUTPUT, "rb") as f:
        written = f.read()
    assert written == data, "output bytes differ from decoded image"
    print(f"Wrote {OUTPUT} ({len(data)} bytes, verified identical to decoded image)")


if __name__ == "__main__":
    main()
