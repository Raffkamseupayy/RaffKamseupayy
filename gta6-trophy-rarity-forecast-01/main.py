"""Trophy Dilution Forecaster for gta6-trophy-rarity-forecast-01.

Idea: Exophase does not refresh its counts continuously. It sits flat for
hours, then jumps: many more players get tracked at once, and because the
newly tracked players have earned fewer trophies, almost every earn rate
falls. A persistence forecast misses that dilution entirely.

So this program forecasts in two steps, both fitted from the case history:

1. How many players will Exophase track at the target?  Player counts grow
   roughly like log(N) against log(1 + hours since the first read), so a
   least-squares line on that scale, extrapolated to the target, gives
   N_target (clamped to [N_last, 100 * N_last]).

2. How does each trophy's rate move as N grows?  For each trophy, a
   least-squares line of logit(rate) against log(N) over the reads where the
   tracked count actually changed. The slope is shrunk 30% toward zero
   (a short, noisy history should not be trusted at full strength), and the
   median is the last rate shifted along that slope to N_target. A trophy
   sitting at ~100% stays there: the logit clamp handles it.

The spread is wider than a plain random walk, because a refresh can move
every rate at once: a base 0.30 logit units plus the walk term plus a term
that grows with how far N is forecast to run. Everything is deterministic:
no randomness, no network, no wall clock.

Standard library only (Python 3.13).
"""

import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

INPUT_DIR = Path(os.environ.get("MAKEFUN_INPUT_DIR", "/input"))
OUTPUT_DIR = Path(os.environ.get("MAKEFUN_OUTPUT_DIR", "/output"))

LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95]
Z = [-1.645, -0.674, 0.0, 0.674, 1.645]

LO = 0.01
HI = 99.99
SHRINK = 0.7          # slope shrinkage toward 0 for the per-trophy fits
BASE_SPREAD = 0.30    # extra logit spread: a refresh can move all rates
SPREAD_FLOOR = 0.35
SPREAD_CAP = 2.2
FALLBACK_SIGMA = 2.0


def clamp_pct(x):
    """Clamp a percent into the range the logit is defined on."""
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    return min(HI, max(LO, v))


def logit(pct):
    p = clamp_pct(pct) / 100.0
    return math.log(p / (1.0 - p))


def inv_logit(lg):
    if lg >= 0:
        return 100.0 / (1.0 + math.exp(-lg))
    e = math.exp(lg)
    return 100.0 * e / (1.0 + e)


def parse_time(text):
    """Parse an ISO-8601 timestamp; return None if it cannot be read."""
    if not isinstance(text, str):
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def least_squares(xs, ys):
    """Return (slope, intercept) of the least-squares line, or None.

    Needs at least two points and some spread in x; a degenerate fit is
    reported as unavailable so the caller can fall back cleanly.
    """
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 1e-12:
        return None
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    return slope, my - slope * mx


def distinct_n_reads(history):
    """Reads with distinct players_tracked, oldest first.

    Flat stretches (same N, same rates) carry no signal about how rates
    move as N grows, so only the first read at each N is kept.
    """
    seen = set()
    out = []
    for read in history:
        n = read.get("players_tracked")
        if not isinstance(n, (int, float)) or n is None or n <= 0:
            continue
        n = float(n)
        if n in seen:
            continue
        seen.add(n)
        out.append(read)
    return out


def forecast_n_target(history, target_hours):
    """Forecast players tracked at the target; returns (n_target, n_last)."""
    reads = distinct_n_reads(history)
    n_last = float(history[-1]["players_tracked"])
    if len(reads) < 2 or target_hours is None:
        return n_last, n_last
    t0 = parse_time(reads[0].get("at"))
    if t0 is None:
        return n_last, n_last
    xs = []
    ys = []
    for read in reads:
        t = parse_time(read.get("at"))
        if t is None:
            continue
        hours = (t - t0).total_seconds() / 3600.0
        if hours < 0:
            continue
        xs.append(math.log1p(hours))
        ys.append(math.log(float(read["players_tracked"])))
    fit = least_squares(xs, ys)
    if fit is None:
        return n_last, n_last
    slope, _intercept = fit
    # Anchor the line at the last observed read and use the fitted slope
    # only for the growth beyond it. A plain least-squares line can sit
    # below the last point (fit residual), which would clamp N_target back
    # to N_last and silence the whole dilution path even when the fitted
    # growth is real; anchoring keeps the level honest and the slope fitted.
    t_last = parse_time(reads[-1].get("at"))
    if t_last is None:
        return n_last, n_last
    hours_last = (t_last - t0).total_seconds() / 3600.0
    log_n = math.log(n_last) + slope * (
        math.log1p(max(0.0, target_hours)) - math.log1p(max(0.0, hours_last))
    )
    n_target = math.exp(log_n)
    if not math.isfinite(n_target):
        return n_last, n_last
    return min(100.0 * n_last, max(n_last, n_target)), n_last


def trophy_median(history, idx, n_target, n_last):
    """Median forecast for one trophy (percent), from its log(N) fit."""
    r_last = None
    for read in reversed(history):
        rates = read.get("rates") or []
        if idx < len(rates) and rates[idx] is not None:
            r_last = clamp_pct(rates[idx])
            break
    if r_last is None:
        return 50.0
    if n_target <= n_last:
        # No forecast growth in tracked players: nothing to dilute with.
        return r_last
    reads = distinct_n_reads(history)
    xs = []
    ys = []
    for read in reads:
        rates = read.get("rates") or []
        if idx >= len(rates) or rates[idx] is None:
            continue
        rate = clamp_pct(rates[idx])
        if rate is None:
            continue
        xs.append(math.log(float(read["players_tracked"])))
        ys.append(logit(rate))
    if len(xs) < 3:
        return r_last
    fit = least_squares(xs, ys)
    if fit is None:
        return r_last
    slope, _intercept = fit
    slope *= SHRINK
    shifted = logit(r_last) + slope * (math.log(n_target) - math.log(n_last))
    return clamp_pct(inv_logit(shifted))


def round4(x):
    v = round(float(x), 4)
    if v == int(v):
        return int(v)
    return v


def forecast_case(case):
    trophies = sorted(case.get("trophies") or [], key=lambda t: t["id"])
    history = case.get("history") or []
    horizon = case.get("horizon_minutes")
    if horizon is None:
        horizon = 0.0
    days = float(horizon) / 1440.0

    if not history:
        # Nothing to learn from: a flat 50% median with a very wide band.
        rows = []
        for trophy in trophies:
            qs = []
            for z in Z:
                qs.append(round4(clamp_pct(inv_logit(logit(50.0) + z * FALLBACK_SIGMA))))
            rows.append({"id": trophy["id"], "q": qs})
        return {"trophies": rows}

    t0 = parse_time(history[0].get("at"))
    t_target = parse_time(case.get("target"))
    target_hours = None
    if t0 is not None and t_target is not None:
        target_hours = (t_target - t0).total_seconds() / 3600.0
    n_target, n_last = forecast_n_target(history, target_hours)

    growth = math.log10(n_target / n_last) if n_last > 0 else 0.0
    sigma = 0.5 * math.sqrt(max(0.0, days)) + BASE_SPREAD + 0.10 * growth
    sigma = min(SPREAD_CAP, max(SPREAD_FLOOR, sigma))

    rows = []
    # rates follow the case's own trophy order, which may differ from id
    # order, so map each trophy id back to its position in that order.
    order = {t["id"]: i for i, t in enumerate(case.get("trophies") or [])}
    for trophy in trophies:
        idx = order.get(trophy["id"], 0)
        median = trophy_median(history, idx, n_target, n_last)
        centre = logit(median)
        qs = []
        prev = None
        for z in Z:
            q = clamp_pct(inv_logit(centre + z * sigma))
            q = round4(q)
            if prev is not None and q < prev:
                q = prev
            qs.append(q)
            prev = q
        rows.append({"id": trophy["id"], "q": qs})
    return {"trophies": rows}


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for path in sorted(INPUT_DIR.glob("*.in")):
        case = json.loads(path.read_text(encoding="utf-8"))
        forecast = forecast_case(case)
        out_path = OUTPUT_DIR / (path.stem + ".out")
        out_path.write_text(
            json.dumps(forecast, separators=(",", ":")) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
