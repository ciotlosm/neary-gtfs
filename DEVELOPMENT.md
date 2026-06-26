# Development Guide

## Prerequisites

- Node.js 24+
- `unzip` on PATH (every CI runner has it; macOS/Linux do too)
- `java` on PATH (only required by the canonical GTFS validator step in CI)

No API keys needed — the pipeline only hits public CTP CSV timetables,
the public CLUJ.zip seed, and `api.transitous.org`.

## Setup

```bash
npm install
```

## Commands

```bash
# Full pipeline → outputs/
npm run pipeline

# Just the Cluj feed build → outputs/feeds/ctp-cluj.gtfs.zip
npm run build:ctp-cluj

# Local end-to-end smoke against an existing zip at
# outputs/feeds/ctp-cluj.gtfs.zip (skips fetch + build steps)
node src/pipeline/_smoke.js
```

Pipeline anatomy lives in [README.md](README.md#pipeline) — no need to
duplicate the diagram here.

## Adding a feed

Single source of truth: `countries.json` `include[]`. Whether the result
is a plain mirror or a locally-enhanced build depends only on whether
a `feeds/<id>/config.json` declares `enhances: "<name>"` matching the
include entry.

### Plain mirror

1. Add the country's ISO code to `countries.json` `countries[]` (if not
   already present).
2. Find the Transitous source name at
   `https://raw.githubusercontent.com/public-transport/transitous/main/feeds/<iso>.json`.
   Confirm `https://api.transitous.org/gtfs/<iso>_<name>.gtfs.zip` returns 200.
3. Add the name to `countries.json` `include[]`.
4. Run `npm run pipeline` locally; confirm `outputs/feeds.json`
   validates and the per-feed `.sqlite3.gz` opens
   (`sqlite3 outputs/feeds/<id>.sqlite3 'SELECT COUNT(*) FROM trips'`).

### Locally-enhanced build

Use only when the upstream feed needs day-of fixes Transitous doesn't
apply (CTP Cluj's case: fresh CSV schedules vs months-stale mdb-2121).

1. Do step 1–3 above so the Transitous source is in `include[]`.
2. `mkdir feeds/<your-id>` (the dir name is yours; it becomes the
   feed id in `feeds.json` unless `config.json` overrides via `id`).
3. Write `feeds/<your-id>/config.json` (see [`feeds/ctp-cluj/config.json`](feeds/ctp-cluj/config.json)).
   Required at top level: `enhances: "<TransitousName>"`, plus
   `name`, `country`, `timezone`, `license`. Optional: `region`,
   `languages`, `realtime`, `tranzy`.
4. Write `feeds/<your-id>/build.js`. The pipeline runs it with
   `NEARY_SEED_ZIP=<absolute path to the Transitous seed zip>` in the
   environment. The script must write the final GTFS to
   `outputs/feeds/<id>.gtfs.zip`.

Orphan enhancers (a `feeds/<id>/` whose `enhances` doesn't match any
include entry) print a warning and produce nothing. Always-mirrored
sources (in `include[]` but no enhancer) are the default case.

## CTP CSV schedule source

CTP publishes CSV files at `https://ctpcj.ro/orare/csv/orar_<route>_<service>.csv`.
- Service IDs: `lv` (weekday), `s` (Saturday), `d` (Sunday)
- URL pattern + service mapping in [`feeds/ctp-cluj/config.json`](feeds/ctp-cluj/config.json)
- Routes without CSV data are skipped (logged); their structural data
  (route + stops + shapes) is preserved from the seed zip — the v2 app
  treats them as sparse-schedule feeds, not missing.

## CI

`.github/workflows/daily.yml` runs nightly (00:30 UTC) and on
`workflow_dispatch`, targeting the `binaries-staging` branch. Once
end-to-end CI is verified, the publish target is renamed to `binaries`
(one-line edit) and jsDelivr is fronted onto raw GitHub URLs.
