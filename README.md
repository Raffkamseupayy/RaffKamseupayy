# Token Radar

The best token launch radar: a program that reads a sealed DefiLlama snapshot of every
protocol, works out which ones still record no token and are not a wrapped or staked product
of one that trades, ranks them by what their launch would be worth, and hands in a web
dashboard with the board, a detail view for each protocol and the steps to farm it.

## What it ranks

- **The board**: all 289 rankable pre-token protocols in the snapshot — the 40 on the
  watchlist (at least $50M TVL, no token on record) plus every other rankable pre-token
  protocol below the floor. Live-token protocols are set aside with their market caps, never
  mixed into the ranking.
- **Implied value (model radar-2)**: `TVL x 0.25 x growth x maturity x chain reach`, where
  growth is seven-day TVL change clamped to -60%/+120% and half-weighted, maturity rises from
  0.6 to 1.0 over three years tokenless, and each extra chain adds 4% (capped at five). Every
  factor comes from the snapshot's own figures; no protocol name is special-cased.
- **Farm plans**: seven steps per protocol, derived from its category, chains, TVL and age —
  a main action, a second qualifying interaction, a weekly cadence, a hold period, a points
  check and a farm log — each with its cost and time.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

It writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the
output directory. The dashboard is a static page with no network: open `out/dashboard/index.html`
in a browser. Search, filter by category or chain, show only the watchlist, sort any column,
and select a row for its model breakdown and farm plan.

## Files

- `main.ts` — the program: reads the snapshot, builds the board, writes the outputs
- `lib/model.ts` — the model, the board builder and the farm plans
- `vendor/makefun-board.ts` — make.fun's dossier library, as shipped in the kit
- `dashboard/` — the page: `index.html`, `app.css`, `app.js`
- `screenshots/` — the board, a protocol's detail view and a filtered view
