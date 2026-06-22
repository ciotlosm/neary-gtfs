#!/usr/bin/env node

/**
 * Fetch routes, stops, trips, and stop_times from the Tranzy API and save them
 * as the agency's registry files (routes.json, stops.json, trips.json).
 *
 * Usage:
 *   TRANZY_API_KEY=<key> node scripts/fetch-tranzy-registry.js --agency <id>
 *
 * Environment:
 *   TRANZY_API_KEY  — required, your Tranzy API key
 *
 * Output (written to agencies/<id>/):
 *   routes.json    — all routes with shortName, routeId, longName, type
 *   stops.json     — all stops with stopId, name, lat, lon
 *   trips.json     — all trips with tripId, routeId, directionId, headsign, shapeId
 *   stop_times.json — stop sequences per trip (tripId → ordered stop_ids)
 *
 * These files are the static registry that the GTFS build script uses to map
 * CTP CSV schedule data to Tranzy-compatible IDs and coordinates. Re-run this
 * script whenever CTP adds/removes routes or stops.
 */

import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { values } = parseArgs({
  options: { agency: { type: 'string', short: 'a' } },
});

const agencyId = values.agency;
if (!agencyId) {
  console.error('Usage: TRANZY_API_KEY=<key> node scripts/fetch-tranzy-registry.js --agency <id>');
  process.exit(1);
}

const API_KEY = process.env.TRANZY_API_KEY;
if (!API_KEY) {
  console.error('Error: TRANZY_API_KEY environment variable is required');
  process.exit(1);
}

const BASE_URL = 'https://api.tranzy.ai/v1/opendata';
const headers = { 'X-API-Key': API_KEY, 'X-Agency-Id': agencyId };

async function fetchJson(endpoint) {
  const url = `${BASE_URL}/${endpoint}`;
  console.log(`  Fetching ${url}...`);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const outDir = join(ROOT, 'agencies', agencyId);
  mkdirSync(outDir, { recursive: true });

  console.log(`[fetch-tranzy-registry] Agency ${agencyId}`);

  // 1. Routes
  const rawRoutes = await fetchJson('routes');
  const routes = {
    _comment: `Auto-generated from Tranzy /routes API for agency_id=${agencyId}`,
    _generated: new Date().toISOString(),
    routes: rawRoutes
      .map(r => ({
        shortName: r.route_short_name,
        routeId: r.route_id,
        longName: r.route_long_name,
        type: r.route_type,
      }))
      .sort((a, b) => a.routeId - b.routeId),
  };
  writeFileSync(join(outDir, 'routes.json'), JSON.stringify(routes, null, 2));
  console.log(`  ✓ routes.json — ${routes.routes.length} routes`);

  // 2. Stops
  const rawStops = await fetchJson('stops');
  const stops = {
    _comment: `Auto-generated from Tranzy /stops API for agency_id=${agencyId}`,
    _generated: new Date().toISOString(),
    stops: rawStops
      .map(s => ({
        stopId: s.stop_id,
        name: s.stop_name,
        lat: s.stop_lat,
        lon: s.stop_lon,
      }))
      .sort((a, b) => a.stopId - b.stopId),
  };
  writeFileSync(join(outDir, 'stops.json'), JSON.stringify(stops, null, 2));
  console.log(`  ✓ stops.json — ${stops.stops.length} stops`);

  // 3. Trips
  const rawTrips = await fetchJson('trips');
  const trips = {
    _comment: `Auto-generated from Tranzy /trips API for agency_id=${agencyId}`,
    _generated: new Date().toISOString(),
    trips: rawTrips
      .map(t => ({
        tripId: t.trip_id,
        routeId: t.route_id,
        directionId: t.direction_id,
        headsign: t.trip_headsign,
        shapeId: t.shape_id,
        serviceId: t.service_id,
      }))
      .sort((a, b) => a.routeId - b.routeId || a.directionId - b.directionId),
  };
  writeFileSync(join(outDir, 'trips.json'), JSON.stringify(trips, null, 2));
  console.log(`  ✓ trips.json — ${trips.trips.length} trips`);

  // 4. Stop times (stop sequences per trip)
  const rawStopTimes = await fetchJson('stop_times');
  // Group by trip_id, sort by stop_sequence
  const byTrip = {};
  for (const st of rawStopTimes) {
    if (!byTrip[st.trip_id]) byTrip[st.trip_id] = [];
    byTrip[st.trip_id].push({ stopId: st.stop_id, sequence: st.stop_sequence });
  }
  for (const tripId of Object.keys(byTrip)) {
    byTrip[tripId].sort((a, b) => a.sequence - b.sequence);
  }
  const stopTimes = {
    _comment: `Auto-generated from Tranzy /stop_times API for agency_id=${agencyId}. Keyed by trip_id, ordered by stop_sequence.`,
    _generated: new Date().toISOString(),
    stopTimes: byTrip,
  };
  writeFileSync(join(outDir, 'stop_times.json'), JSON.stringify(stopTimes, null, 2));
  console.log(`  ✓ stop_times.json — ${Object.keys(byTrip).length} trips with stop sequences`);

  console.log(`\n[fetch-tranzy-registry] Done. Files written to ${outDir}/`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
