# Development Guide

## Prerequisites

- Node.js 24+
- `unzip` and `java` on PATH (CI runners have both; macOS/Linux usually do too)

No API keys needed. The pipeline runs against public CTP CSV timetables
and the public CLUJ.zip seed.

## Setup

```bash
npm install
```

## Commands

```bash
# Full pipeline (everything → outputs/)
npm run pipeline

# Just the Cluj feed build (outputs/feeds/ctp-cluj.gtfs.zip)
npm run build:ctp-cluj

# Multi-feed pipeline including Transitous-mirrored feeds (M2 path)
RESOLVE_INCLUDE_TRANSITOUS=true npm run pipeline

# Local end-to-end smoke against an existing zip
node src/pipeline/_smoke.js
```

## Pipeline anatomy

```
src/pipeline/build-all.js
  ├─ resolve-feeds.js   ← countries.json + Transitous ro.json
  ├─ for each feed:
  │   ├─ fetch-gtfs.js  ← build local (ctp-cluj) or fetch upstream
  │   ├─ derive-bbox.js ← unzip -p → stops.txt + agency.txt + feed_info.txt
  │   └─ make-sqlite.js ← M2 stub
  └─ make-app-registry.js → outputs/feeds.json (Ajv-validated)
```

`feeds/ctp-cluj/build.js` is invoked by `fetch-gtfs.js`. It seeds from
the public `external.gtfs.ro/cluj/CLUJ.zip` (no API key, no Tranzy),
scrapes ctpcj.ro CSV schedules, and emits the enhanced zip directly to
`outputs/feeds/ctp-cluj.gtfs.zip`.

## Outputs

```
outputs/
├── feeds.json
└── feeds/
    └── ctp-cluj.gtfs.zip   (+ .sqlite3.gz once M2 lands)
```

## CI

`.github/workflows/daily.yml` runs nightly (00:30 UTC), targeting the
`binaries-staging` branch. After M2 stabilizes, the branch is promoted
to `binaries` and consumed by the v2 PWA.

## CTP CSV schedule source

CTP publishes CSV files at `https://ctpcj.ro/orare/csv/orar_<route>_<service>.csv`
- Service IDs: `lv` (weekday), `s` (Saturday), `d` (Sunday)
- Headers in [`feeds/ctp-cluj/config.json`](feeds/ctp-cluj/config.json)
- Build skips routes without CSV data (logged); the seed retains their
  structural metadata (route + stops + shapes), only the schedule is
  missing — handled by the v2 app as a regular GTFS feed with sparse
  service coverage on those route_ids.

## Adding a new agency (M2+ scope)

1. Add the country's ISO code to `countries.json`.
2. Verify `https://raw.githubusercontent.com/public-transport/transitous/main/feeds/<iso>.json`
   contains a usable `type: http | transitland-atlas | mobility-database`
   entry for the agency.
3. Run `RESOLVE_INCLUDE_TRANSITOUS=true npm run pipeline` locally; check
   `outputs/feeds.json` validates and the per-feed `.gtfs.zip` is sane.
4. Push to `binaries-staging`. Validate via the v2 app pointed at staging.

