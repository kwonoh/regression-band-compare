# regression-band-compare

Draws the same data with vgplot's `regressionY` and Observable Plot's `linearRegressionY`, before and after the confidence band fix in https://github.com/kwonoh/mosaic/tree/fix/regression-confidence-band, and measures how far apart the bands are.

## Setup

```sh
git clone -b fix/regression-confidence-band https://github.com/kwonoh/mosaic.git ../mosaic
(cd ../mosaic && pnpm install && pnpm exec playwright install chromium)
```

## Run

```sh
MOSAIC_DIR=../mosaic node compare.js
```

Then open `out/report.html`. The raw numbers are in `out/results.json`.

## How it works

Both plots get the same DuckDB table, size, margins, and domains. vgplot runs from the mosaic checkout's source, and the only thing that changes between the two runs is `RegressionMark.js`, taken from `HEAD~1` (before) and `HEAD` (after). Use `BEFORE_REV` and `AFTER_REV` to pick other commits, or `SOURCE_REPO` to read them from a different clone. Set `CHROMIUM` if you'd rather use your own browser than Playwright's.

There's nothing to install here; vite, playwright, duckdb-wasm, and Plot all come from the mosaic checkout.

The athletes data is loaded from `athletes.csv` instead of the parquet file, since DuckDB-WASM downloads its parquet extension from extensions.duckdb.org and that isn't reachable behind some firewalls.
