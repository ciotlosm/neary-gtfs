# neary-gtfs

Daily pipeline producing GTFS feeds for the [neary](https://github.com/ciotlosm/neary) PWA v2.

Roadmap: [neary docs/rebuild-v2/neary-gtfs-plan.md §10](https://github.com/ciotlosm/neary/blob/rebuild/v2-svelte-sqlite/docs/rebuild-v2/neary-gtfs-plan.md#10-evolution-roadmap).
Current milestone: **M2** — SQLite generation + first Transitous-mirrored feed.

The legacy `releases` branch on the remote stays alive for the v1 PWA;
nothing on `main` produces it anymore.

## What it produces

Published nightly to the `binaries-staging` branch by
[`.github/workflows/daily.yml`](.github/workflows/daily.yml) (promotes
to `binaries` once CI is verified end-to-end):

| File | Source | Consumer |
|------|--------|----------|
| `feeds.json` | pipeline | neary v2 app (single registry) |
| `feeds/<id>.gtfs.zip` | local build (ctp-cluj) / Transitous mirror | external validators |
| `feeds/<id>.sqlite3.gz` | `make-sqlite.js` | neary v2 app (OPFS) |

Current feeds (verified locally):

| id | source | gtfs.zip | sqlite3.gz | rows |
|---|---|---:|---:|---|
| `ctp-cluj` | local CSV enhance | 1.7 MB | 5.4 MB | 14k trips · 193k stop_times · 70k shape pts |
| `bucuresti-ilfov` | Transitous mirror | 7.8 MB | 25 MB | 63k trips · 1.33M stop_times · 82k shape pts |

`feeds.json` is Ajv-validated against
[`schemas/feeds.schema.json`](schemas/feeds.schema.json) (draft-2020).
The build also runs the canonical MobilityData GTFS validator on each
zip and fails on any `ERROR`.

## Pipeline

`npm run pipeline` (`src/pipeline/build-all.js`):

1. `resolve-feeds.js` — `countries.json` (countries + `include` whitelist)
   + Transitous `feeds/<iso>.json` → feed list. `ctp-cluj` is always prepended.
2. For each feed:
   - `fetch-gtfs.js` — for `ctp-cluj`: invoke `feeds/ctp-cluj/build.js`;
     for Transitous feeds: download from
     `api.transitous.org/gtfs/<iso>_<name>.gtfs.zip`
   - `derive-bbox.js` — `unzip -p` the zip's `stops.txt` / `agency.txt` /
     `feed_info.txt` → bbox, agencies, validity dates
   - `make-sqlite.js` — `.zip` → `.sqlite3.gz` (gzipped SQLite blob the
     v2 app's worker opens via OPFS-SAHPool)
3. `make-app-registry.js` — write `outputs/feeds.json`.

App consumes from:
```
https://raw.githubusercontent.com/ciotlosm/neary-gtfs/binaries-staging/feeds.json
```
(jsDelivr in front once `binaries-staging` is promoted to `binaries`.)

### CTP Cluj enhancement

`feeds/ctp-cluj/build.js`:
- Fetches `https://external.gtfs.ro/cluj/CLUJ.zip` (the mdb-2121 mirror) as seed
- Keeps `agency.txt`, `routes.txt`, `stops.txt`, `shapes.txt` from seed
- **Regenerates** `calendar.txt`, `trips.txt`, `stop_times.txt` from
  daily CTP CSV scrapes (`ctpcj.ro/orare/csv/orar_<route>_<svc>.csv`)
- Adds `feed_info.txt` with `feed_publisher_name="neary-gtfs"`
- Re-zips → `outputs/feeds/ctp-cluj.gtfs.zip`

Trip IDs follow the canonical CTP format
`<route_id>_<dir>_<service>_<seq>_<HHMM>` (e.g. `45_1_LV_9_0721`),
which matches the `cluj-rt-feed.gtfs.ro` GTFS-Realtime feed exactly.

## Structure

```
countries.json                # { countries: [iso], include: [transitous source names] }
schemas/feeds.schema.json     # JSON Schema for outputs/feeds.json
src/pipeline/
  build-all.js                # orchestrator
  resolve-feeds.js            # countries.json + Transitous → feed list
  fetch-gtfs.js               # build local or fetch upstream
  derive-bbox.js              # zip → bbox + agencies + validity
  make-sqlite.js              # zip → .sqlite3.gz
  make-app-registry.js        # → outputs/feeds.json (Ajv-validated)
  _smoke.js                   # local end-to-end check
feeds/ctp-cluj/               # the only custom-built feed
  build.js                    # CSV enhance of CLUJ.zip
  config.json                 # CSV URL pattern, service IDs, ...
  lib/{csv,seed}.js           # parsers/loaders
.github/workflows/daily.yml   # cron 00:30 UTC → binaries-staging
```

## Local development

See [DEVELOPMENT.md](DEVELOPMENT.md).

## License

Schedule data © CTP Cluj-Napoca. Generated for public transit information purposes.
