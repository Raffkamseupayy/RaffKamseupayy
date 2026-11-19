# Trophy Dilution Forecaster — gta6-trophy-rarity-forecast-01

Entry for @rappcuyy. Forecasts every GTA VI trophy's Exophase earn rate at
2026-11-26T00:00Z as five quantiles, from the house's recorded reads up to the
deadline.

## The idea

Exophase does not refresh continuously: it sits flat for hours, then jumps.
When it jumps, many more players get tracked at once, and because the newly
tracked players have earned fewer trophies, almost every earn rate falls.
A persistence forecast misses that dilution entirely — on the practice it
scores ~1.51 pinball loss with 0% 90%-coverage.

This program forecasts in two fitted steps:

1. **Players tracked at the target.** Least-squares fit of log(N) on
   log(1 + hours since first read), anchored at the last observed read,
   extrapolated to the target, clamped to [N_last, 100 * N_last].
2. **Each trophy's rate as N grows.** Least-squares fit of logit(rate) on
   log(N) over reads where the tracked count actually changed (flat stretches
   deduplicated), slope shrunk 30% toward zero; the median is the last rate
   shifted along that slope to N_target. A trophy at ~100% stays ~100%.

The spread is wider than a plain random walk (base 0.30 logit units plus the
walk term plus a term growing with forecast N growth), because a refresh can
move every rate at once.

## Files

- `main.py` — the entry. Python 3.13, standard library only. Reads every
  `*.in` in `$MAKEFUN_INPUT_DIR` (else `/input/`), writes `/output/<id>.out`
  (`$MAKEFUN_OUTPUT_DIR` else `/output/`). Deterministic, no network, no
  wall clock.

## Local test results (2026-11-19)

- Practice p00/p01: valid, 55 rows each, non-decreasing quantiles in 0–100,
  2,670 bytes, ~0.05 s per run, byte-identical across runs. Histories are
  flat (638 players), so medians equal last rates; the 90% band is ~3.6x
  wider than the house baseline's (mean width 1.30 vs 0.36 points).
- Synthetic varying-N case (N 638 → 3,868, rates falling as N grows):
  all 55 medians move down at a 90-min horizon (e.g. 0.40% → 0.3741%),
  and roughly halve at a final-like 6,510-min horizon (0.40% → 0.1982%).
