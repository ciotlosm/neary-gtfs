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

Mirror an existing Transitous source (preferred):

1. Add the country's ISO code to `countries.json` `countries[]` (if not
   already present).
2. Find the Transitous source name at
   `https://raw.githubusercontent.com/public-transport/transitous/main/feeds/<iso>.json`.
   The `name` field must resolve to
   `https://api.transitous.org/gtfs/<iso>_<name>.gtfs.zip` (200 OK).
3. Add that name to `countries.json` `include[]`.
4. Run `npm run pipeline` locally. Confirm
   `outputs/feeds.json` validates and the per-feed `.sqlite3.gz` opens
   in `sqlite3` (`sqlite3 outputs/feeds/<id>.sqlite3 'SELECT COUNT(*) FROM trips'`).
5. Push to a branch and run the daily workflow via `workflow_dispatch`.

Local-build feed (only if Transitous coverage is unacceptable):
copy the `feeds/ctp-cluj/` layout, wire it into `fetch-gtfs.js`. Avoid
unless really necessary — Transitous gets free mdb-2121-style updates
across ~100 downstream consumers.

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
