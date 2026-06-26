# neary-gtfs

Daily pipeline producing GTFS feeds for the [neary](https://github.com/ciotlosm/neary) PWA.

> **Active refactor**: the `refactor/feeds-from-transitous` branch is
> migrating to a multi-feed model aligned with
> [public-transport/transitous](https://github.com/public-transport/transitous).
> The legacy Tranzy-driven path is gone here; the `releases` branch on
> the remote (which v1 PWAs still consume) is left untouched.
>
> Roadmap: [neary docs/rebuild-v2/neary-gtfs-plan.md §10](https://github.com/ciotlosm/neary/blob/rebuild/v2-svelte-sqlite/docs/rebuild-v2/neary-gtfs-plan.md#10-evolution-roadmap)
> (M0 → M5). Current milestone: **M1+** — scaffold + Tranzy removal.

## What it produces

Published to the `binaries-staging` branch by
[`.github/workflows/daily.yml`](.github/workflows/daily.yml):

| File | Source | Consumer |
|------|--------|----------|
| `feeds.json` | new pipeline | neary v2 app (single registry) |
| `feeds/ctp-cluj.gtfs.zip` | `feeds/ctp-cluj/build.js` (CTP CSV enhance of CLUJ.zip seed) | neary v2 app + GTFS validators |

`feeds.json` is schema-validated at build time
([`schemas/feeds.schema.json`](schemas/feeds.schema.json), draft-2020).

## How it works

`.github/workflows/daily.yml` runs at 00:30 UTC (after Transitous's
daily import) or on manual trigger:

1. **Pipeline** (`npm run pipeline`):
   - `resolve-feeds.js` — `countries.json` + Transitous `feeds/<iso>.json`
     → feed list (M1 emits only `ctp-cluj`; `RESOLVE_INCLUDE_TRANSITOUS=true`
     opts into the multi-feed path landing in M2)
   - `fetch-gtfs.js` — for `ctp-cluj`: invoke `feeds/ctp-cluj/build.js`;
     for Transitous feeds: download from `api.transitous.org/gtfs/...`
   - `derive-bbox.js` — extract `stops.txt`/`agency.txt`/`feed_info.txt`
     via `unzip -p`
   - `make-sqlite.js` — stub (M2 ports the SQLite generator)
   - `make-app-registry.js` — write `outputs/feeds.json`, Ajv-validate
2. **GTFS validator** — canonical MobilityData validator; fails on any ERROR
3. **Publish** — push `outputs/` → `binaries-staging` branch

The Cluj enhancement (`feeds/ctp-cluj/build.js`):
- Fetches `https://external.gtfs.ro/cluj/CLUJ.zip` (mdb-2121 mirror) as seed
- Keeps `agency.txt`, `routes.txt`, `stops.txt`, `shapes.txt` from seed
- **Regenerates** `calendar.txt`, `trips.txt`, `stop_times.txt` from
  daily CTP CSV scrapes (`https://ctpcj.ro/orare/csv/orar_<route>_<svc>.csv`)
- Adds `feed_info.txt` with `feed_publisher_name="neary-gtfs"`
- Re-zips into `outputs/feeds/ctp-cluj.gtfs.zip`

Trip IDs follow the canonical CTP format
`<route_id>_<dir>_<service>_<seq>_<HHMM>` (e.g. `45_1_LV_9_0721`), which
matches the `cluj-rt-feed.gtfs.ro` GTFS-Realtime feed exactly.

App consumes from (M1+):
```
https://raw.githubusercontent.com/ciotlosm/neary-gtfs/binaries-staging/feeds.json
```
M2 will rename the publish branch to `binaries` and put jsDelivr in front.

## Structure

```
countries.json                  # ISO codes whose Transitous feeds we mirror
schemas/feeds.schema.json       # JSON Schema (draft-2020) for outputs/feeds.json
src/pipeline/
  build-all.js                  # orchestrator (npm run pipeline)
  resolve-feeds.js              # countries.json + Transitous → feed list
  fetch-gtfs.js                 # build local or fetch upstream
  derive-bbox.js                # zip → bbox + agencies + validity
  make-sqlite.js                # M2 stub
  make-app-registry.js          # → outputs/feeds.json (Ajv-validated)
  _smoke.js                     # local end-to-end check (no CI)
feeds/ctp-cluj/                 # the ONLY custom-built feed
  build.js                      # CSV enhance of CLUJ.zip
  config.json                   # CSV URL pattern, service IDs, ...
  lib/{csv,seed}.js             # parsers/loaders
.github/workflows/daily.yml     # cron 00:30 UTC → binaries-staging
```

## Local development

See [DEVELOPMENT.md](DEVELOPMENT.md).

## License

Schedule data © CTP Cluj-Napoca. Generated for public transit information purposes.

