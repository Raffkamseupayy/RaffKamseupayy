# Tiny Chess — 4 KB Python Chess Engine

A compact chess engine in a single `main.py` (4,070 bytes), written for the
make.fun bounty "Build the strongest chess engine in 4 KB of Python".

## What it does

Plays full games of chess against the house gauntlet over HTTP
(`$MAKEFUN_ENV_URL/game`, `/move`, `/resign`). Python 3.13 stdlib only
(`urllib`, `lzma`, `base64`, `random`, `sys`, `os`).

## How it plays

- **Board:** 0x88 (128 squares), Zobrist hashing, incremental make/unmake.
- **Search:** iterative deepening alpha-beta with a **fixed node cap**
  (100,000 nodes/move — never a clock, so replays are deterministic),
  transposition table, quiescence search over captures/promotions/check
  evasions (with checkmate detection), MVV-LVA capture ordering + 2 killer
  moves per ply, and threefold-repetition detection from the game history.
- **Evaluation:** material (P100 N320 B330 R500 Q900) + Michniewski
  piece-square tables + bishop-pair bonus, from the side-to-move's
  perspective.
- **Move generation:** verified by perft (startpos, Kiwipete, and 4 more
  suites match exactly).

## Packing

The engine source is LZMA-compressed and base64-encoded inside `main.py`;
the one-line unpacker decompresses and execs it at startup. Payload +
unpacker = 4,070 bytes, under the 4,096-byte cap. The readable source is
`engine_src.py` (build artifact, not part of the entry).

## Local practice trial

Practice trial-0 (6 games vs depth-2 … nodes-500k): **Elo 1,279**
(3 wins, 0 draws, 3 losses) — above the 1,154 entry floor. See the
submission report for the full game log.

## License

MIT — see `LICENSE`.
