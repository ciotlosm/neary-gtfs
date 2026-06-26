/**
 * Seed loader: fetches CLUJ.zip from external.gtfs.ro, extracts to a temp dir,
 * and parses the standard GTFS .txt files into the same in-memory shapes the
 * Cluj enhancement build expects.
 *
 * Returns:
 *   {
 *     seedDir,                // absolute path to extracted .txt files
 *     agencyTxt: string,      // raw agency.txt content (passed through)
 *     routes:  [{ routeId, shortName, longName, type, color }],
 *     stops:   [{ stopId, name, lat, lon }],
 *     trips:   [{ tripId, routeId, directionId, headsign, shapeId, serviceId }],
 *     stopTimes: Map<tripId, [{ stopId, sequence }]>,  // sorted by sequence
 *   }
 */

import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseGtfsCsv } from './csv.js';

const REQUIRED = ['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt'];
const OPTIONAL = ['shapes.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt'];

async function fetchToFile(url, dest) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'neary-gtfs/2.0 (https://github.com/ciotlosm/neary-gtfs)' },
  });
  if (!res.ok || !res.body) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return dest;
}

export async function loadSeed(zipUrl) {
  const seedDir = mkdtempSync(join(tmpdir(), 'neary-ctp-seed-'));
  const zipPath = join(seedDir, 'seed.zip');

  console.log(`[seed] fetching ${zipUrl}`);
  await fetchToFile(zipUrl, zipPath);
  console.log(`[seed] zip size: ${(statSync(zipPath).size / 1024).toFixed(1)} KB`);

  // Extract everything to seedDir (flat — GTFS zips don't have subdirectories)
  const r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', seedDir]);
  if (r.status !== 0) throw new Error(`unzip failed (status ${r.status})`);

  for (const f of REQUIRED) {
    try { statSync(join(seedDir, f)); }
    catch { throw new Error(`seed missing required file: ${f}`); }
  }

  const agencyTxt = readFileSync(join(seedDir, 'agency.txt'), 'utf8');
  const routesRows = parseGtfsCsv(readFileSync(join(seedDir, 'routes.txt'), 'utf8'));
  const stopsRows = parseGtfsCsv(readFileSync(join(seedDir, 'stops.txt'), 'utf8'));
  const tripsRows = parseGtfsCsv(readFileSync(join(seedDir, 'trips.txt'), 'utf8'));
  const stopTimesRows = parseGtfsCsv(readFileSync(join(seedDir, 'stop_times.txt'), 'utf8'));

  const routes = routesRows.map((r) => ({
    routeId: r.route_id,
    shortName: r.route_short_name,
    longName: r.route_long_name,
    type: r.route_type,
    color: r.route_color || '',
  }));

  const stops = stopsRows.map((s) => ({
    stopId: s.stop_id,
    name: s.stop_name,
    lat: parseFloat(s.stop_lat),
    lon: parseFloat(s.stop_lon),
  }));

  const trips = tripsRows.map((t) => ({
    tripId: t.trip_id,
    routeId: t.route_id,
    directionId: t.direction_id ? Number(t.direction_id) : 0,
    headsign: t.trip_headsign || '',
    shapeId: t.shape_id || '',
    serviceId: t.service_id,
  }));

  // Group stop_times by trip_id; sort by stop_sequence
  const stopTimes = new Map();
  for (const st of stopTimesRows) {
    const entry = { stopId: st.stop_id, sequence: parseInt(st.stop_sequence, 10) };
    if (!stopTimes.has(st.trip_id)) stopTimes.set(st.trip_id, []);
    stopTimes.get(st.trip_id).push(entry);
  }
  for (const arr of stopTimes.values()) arr.sort((a, b) => a.sequence - b.sequence);

  console.log(`[seed] parsed: ${routes.length} routes, ${stops.length} stops, ${trips.length} trips, ${stopTimesRows.length} stop_times`);

  return { seedDir, agencyTxt, routes, stops, trips, stopTimes, optional: OPTIONAL };
}
