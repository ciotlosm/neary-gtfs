# Development Guide

## Prerequisites

- Node.js 20+
- A Tranzy API key (set as `TRANZY_API_KEY` environment variable)

## Initial setup

```bash
npm install
```

## Populating the agency registry

Before building GTFS data, each agency needs its route/stop/trip registry populated from the Tranzy API. This is a **one-time setup** (re-run when CTP adds/removes routes or stops):

```bash
# Fetch all routes, stops, trips, and stop_times for CTP Cluj (agency 2)
TRANZY_API_KEY=<your-key> node scripts/fetch-tranzy-registry.js --agency 2
```

This creates/overwrites:
- `agencies/2/routes.json` — route short names → Tranzy route_id
- `agencies/2/stops.json` — stop names + coordinates
- `agencies/2/trips.json` — trips with direction, headsign, shape
- `agencies/2/stop_times.json` — stop sequences per trip (which stops a route visits, in order)

These files are committed to the repo (they're the static mapping that lets the build script generate Tranzy-compatible GTFS IDs).

## Building GTFS

```bash
# Build GTFS ZIP for CTP Cluj
node src/build.js --agency 2
```

Output goes to `output/agency-2/CLUJ.zip`.

## Adding a new agency

1. Get the Tranzy `agency_id` (visible in the Tranzy API `/agency` response)
2. Create `agencies/<id>/config.json` with the agency's URL patterns (copy from agency 2)
3. Run the registry fetch: `TRANZY_API_KEY=<key> node scripts/fetch-tranzy-registry.js --agency <id>`
4. Create `.github/workflows/build-agency-<id>.yml` (copy from `build-agency-2.yml`)
5. Commit all files

## How the CSV schedule source works

CTP Cluj publishes CSV files at:
```
https://ctpcj.ro/orare/csv/orar_<routeShortName>_<serviceId>.csv
```

Where `serviceId` is:
- `lv` — weekday (Luni-Vineri)
- `s` — Saturday (Sâmbăta)
- `d` — Sunday (Duminica)

Format (5-line header + data rows):
```csv
route_long_name,P-ta M. Viteazul - Str. Campului
service_name,Luni - Vineri
service_start,22.06.2026
in_stop_name,Pod Traian
out_stop_name,Biserica Campului
05:00,05:20
05:45,06:10
...
```

- Column 1 = departure from the direction-0 start station
- Column 2 = departure from the direction-1 start station
- Each row is one trip per direction

## How we match CSV → Tranzy

| CSV field | Source | Maps to |
|-----------|--------|---------|
| Route "42" | URL + `routes.json` | `route_id = 40` |
| `in_stop_name` | CSV header | Direction 0 start `stop_id` (from `stop_times.json`) |
| `out_stop_name` | CSV header | Direction 1 start `stop_id` (from `stop_times.json`) |
| Column 1 times | CSV body | Direction 0 trip departure times |
| Column 2 times | CSV body | Direction 1 trip departure times |
| Intermediate stops | `stop_times.json` | Full stop sequence per direction |
| Stop coordinates | `stops.json` | lat/lon for `stops.txt` |
| Intermediate arrival times | Interpolated | Evenly distributed across trip duration |
