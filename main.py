"""Make the AI judge happy — entry for make.fun bounty ai-happy-01.

Reads the bundled joyful image (entry.jpg.b64, base64 text) and writes
the decoded JPEG bytes to /output/entry.png. Deterministic: both runs
write identical bytes.
"""

import base64
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "entry.jpg.b64")
DST = "/output/entry.png"


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        b64_text = f.read()
    data = base64.b64decode(b64_text)
    os.makedirs(os.path.dirname(DST), exist_ok=True)
    with open(DST, "wb") as f:
        f.write(data)
    # Verify the output is a byte-identical copy of the decoded image.
    with open(DST, "rb") as f:
        written = f.read()
    assert written == data, "output bytes differ from decoded image"
    print(f"Wrote {DST} ({len(written)} bytes, verified identical to decoded image)")


if __name__ == "__main__":
    main()
