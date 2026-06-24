#!/usr/bin/env node

/**
 * neary-gtfs build script
 *
 * Usage: node src/build.js --agency <agency_id>
 *
 * Pipeline:
 * 1. Load agency config + registry (routes, stops, stop_times)
 * 2. Fetch CSV schedules from CTP for all routes × 3 service days
 * 3. Parse CSV → departure times per direction
 * 4. Generate GTFS files (agency.txt, routes.txt, stops.txt, trips.txt,
 *    stop_times.txt, calendar.txt)
 * 5. Package into ZIP
 * 6. Compare content hash with previous build
 * 7. Write CHANGED marker if data differs
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Parse CLI args
const { values } = parseArgs({
  options: { agency: { type: 'string', short: 'a' } },
});
const agencyId = values.agency;
if (!agencyId) {
  console.error('Usage: node src/build.js --agency <agency_id>');
  process.exit(1);
}

// Load registry
const agencyDir = join(ROOT, 'agencies', agencyId);
const config = JSON.parse(readFileSync(join(agencyDir, 'config.json'), 'utf8'));
const routeRegistry = JSON.parse(readFileSync(join(agencyDir, 'routes.json'), 'utf8'));
const stopRegistry = JSON.parse(readFileSync(join(agencyDir, 'stops.json'), 'utf8'));
const tripRegistry = JSON.parse(readFileSync(join(agencyDir, 'trips.json'), 'utf8'));
const stopTimesRegistry = JSON.parse(readFileSync(join(agencyDir, 'stop_times.json'), 'utf8'));

const outputDir = join(ROOT, 'output', `agency-${agencyId}`);
mkdirSync(outputDir, { recursive: true });

const LOG = (msg) => console.log(`[neary-gtfs] ${msg}`);
LOG(`Building GTFS for agency ${agencyId}: ${config.name}`);
LOG(`Routes: ${routeRegistry.routes.length}, Stops: ${stopRegistry.stops.length}`);

// ============================================================================
// Step 1: Fetch CSVs
// ============================================================================

const SERVICE_IDS = ['lv', 's', 'd'];
const SERVICE_MAP = { lv: 'LV', s: 'S', d: 'D' };

async function fetchCsv(routeShortName, serviceId) {
  const url = config.csvUrlPattern
    .replace('{routeShortName}', routeShortName)
    .replace('{serviceId}', serviceId);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'neary-gtfs/1.0 (https://github.com/ciotlosm/neary-gtfs)' },
    });
    if (!res.ok) {
      if (res.status !== 404) LOG(`  ⚠ ${routeShortName}_${serviceId}: HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    LOG(`  ⚠ ${routeShortName}_${serviceId}: ${err.message || err}`);
    return null;
  }
}

function parseCsv(csvText) {
  const lines = csvText.trim().split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length < 6) return null;

  // Header: 5 lines of metadata
  const routeLongName = lines[0].split(',').slice(1).join(',').replace(/"/g, '');
  const serviceName = lines[1].split(',').slice(1).join(',').replace(/"/g, '');
  const serviceStart = lines[2].split(',').slice(1).join(',').replace(/"/g, '');
  const inStopName = lines[3].split(',').slice(1).join(',').replace(/"/g, '');
  const outStopName = lines[4].split(',').slice(1).join(',').replace(/"/g, '');

  // Data rows: col1 = direction 0 departure, col2 = direction 1 departure
  const departures = { dir0: [], dir1: [] };
  for (let i = 5; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim());
    if (parts[0] && /^\d{1,2}:\d{2}$/.test(parts[0])) departures.dir0.push(parts[0]);
    if (parts[1] && /^\d{1,2}:\d{2}$/.test(parts[1])) departures.dir1.push(parts[1]);
  }

  // Fix post-midnight times: CTP CSVs list departures in chronological order.
  // Night routes go 23:00, 23:30, 0:00, 0:30, 1:00. The 0:xx times are
  // AFTER midnight (next calendar day) but belong to the same service day.
  // GTFS convention: use 24:00, 24:30, 25:00 for post-midnight trips.
  // We detect this by checking if a time is EARLIER than the previous one.
  fixPostMidnight(departures.dir0);
  fixPostMidnight(departures.dir1);

  return { routeLongName, serviceName, serviceStart, inStopName, outStopName, departures };
}

/**
 * Fix post-midnight times in a sorted departure list. If a time is earlier
 * than the previous one (e.g. "0:30" after "23:30"), add 24 hours to it.
 * Mutates the array in place.
 */
function fixPostMidnight(times) {
  let prevMinutes = -1;
  for (let i = 0; i < times.length; i++) {
    const [h, m] = times[i].split(':').map(Number);
    const minutes = h * 60 + m;
    if (minutes < prevMinutes && prevMinutes > 20 * 60) {
      // This time wrapped past midnight — add 24h
      times[i] = `${h + 24}:${String(m).padStart(2, '0')}`;
    }
    // Track the effective minutes for next comparison
    const [effH, effM] = times[i].split(':').map(Number);
    prevMinutes = effH * 60 + effM;
  }
}

// ============================================================================
// Step 2: Generate GTFS
// ============================================================================

function timeToSeconds(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
}

function formatGtfsTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Haversine distance in meters between two lat/lon points. */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Build a stop_id → {lat, lon} lookup from the stop registry. */
const stopCoords = new Map(stopRegistry.stops.map(s => [s.stopId, { lat: s.lat, lon: s.lon }]));

/**
 * Interpolate stop times proportional to cumulative distance between stops.
 * Falls back to even distribution if coordinates are missing.
 *
 * @param startSec - trip departure time in seconds since midnight
 * @param stopSequence - ordered array of {stopId, sequence}
 * @param avgSpeedKmh - average speed assumption (default 18 km/h for urban bus)
 * @returns array of time-in-seconds per stop
 */
function interpolateStopTimes(startSec, stopSequence, avgSpeedKmh = 18) {
  const numStops = stopSequence.length;
  if (numStops <= 1) return [startSec];

  // Compute cumulative distances
  const cumDist = [0];
  let totalDist = 0;
  let allCoordsFound = true;

  for (let i = 1; i < numStops; i++) {
    const prev = stopCoords.get(stopSequence[i - 1].stopId);
    const curr = stopCoords.get(stopSequence[i].stopId);
    if (prev && curr) {
      totalDist += haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
    } else {
      allCoordsFound = false;
      totalDist += 400; // fallback ~400m per stop gap
    }
    cumDist.push(totalDist);
  }

  // Total trip duration from distance + speed (capped at reasonable range)
  const totalDurationSec = Math.round((totalDist / 1000 / avgSpeedKmh) * 3600);
  // Minimum 1 min per stop, maximum 5 min per stop (sanity bounds)
  const bounded = Math.max(numStops * 60, Math.min(numStops * 300, totalDurationSec));

  // Distribute time proportionally to distance
  const times = [];
  for (let i = 0; i < numStops; i++) {
    const fraction = totalDist > 0 ? cumDist[i] / totalDist : i / (numStops - 1);
    times.push(startSec + Math.round(fraction * bounded));
  }
  return times;
}

function generateGtfs(allSchedules) {
  // agency.txt
  const agencyTxt = [
    'agency_id,agency_name,agency_url,agency_timezone,agency_lang',
    `${agencyId},${config.name},${config.url},${config.timezone},${config.lang}`,
  ].join('\n');

  // routes.txt
  const routeLines = ['route_id,agency_id,route_short_name,route_long_name,route_type,route_color'];
  for (const r of routeRegistry.routes) {
    routeLines.push(`${r.routeId},${agencyId},${r.shortName},${r.longName},${r.type},`);
  }
  const routesTxt = routeLines.join('\n');

  // stops.txt
  const stopLines = ['stop_id,stop_name,stop_lat,stop_lon'];
  for (const s of stopRegistry.stops) {
    stopLines.push(`${s.stopId},${s.name},${s.lat},${s.lon}`);
  }
  const stopsTxt = stopLines.join('\n');

  // calendar.txt
  const today = new Date();
  const startDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}01`;
  const endMonth = new Date(today.getFullYear(), today.getMonth() + 6, 0);
  const endDate = `${endMonth.getFullYear()}${String(endMonth.getMonth() + 1).padStart(2, '0')}${String(endMonth.getDate()).padStart(2, '0')}`;
  const calendarTxt = [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    `LV,1,1,1,1,1,0,0,${startDate},${endDate}`,
    `S,0,0,0,0,0,1,0,${startDate},${endDate}`,
    `D,0,0,0,0,0,0,1,${startDate},${endDate}`,
    `LD,1,1,1,1,1,1,1,${startDate},${endDate}`,
  ].join('\n');

  // trips.txt + stop_times.txt
  const tripLines = ['route_id,service_id,trip_id,trip_headsign,direction_id,shape_id'];
  const stLines = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence'];

  for (const schedule of allSchedules) {
    const { routeId, serviceId, departures, dir, stopSequence, headsign } = schedule;
    for (let seq = 0; seq < departures.length; seq++) {
      const depTime = departures[seq];
      const tripId = `${routeId}_${dir}_${serviceId}_${seq}_${depTime.replace(':', '')}`;
      const shapeId = tripRegistry.trips.find(t => t.routeId === routeId && t.directionId === dir)?.shapeId || '';

      tripLines.push(`${routeId},${serviceId},${tripId},${headsign},${dir},${shapeId}`);

      // Interpolate stop times using distance-proportional distribution
      const startSec = timeToSeconds(depTime);
      const numStops = stopSequence.length;
      const stopTimes = interpolateStopTimes(startSec, stopSequence);

      for (let i = 0; i < numStops; i++) {
        const timeStr = formatGtfsTime(stopTimes[i]);
        stLines.push(`${tripId},${timeStr},${timeStr},${stopSequence[i].stopId},${i}`);
      }
    }
  }

  const tripsTxt = tripLines.join('\n');
  const stopTimesTxt = stLines.join('\n');

  return { agencyTxt, routesTxt, stopsTxt, calendarTxt, tripsTxt, stopTimesTxt };
}

// ============================================================================
// Step 3: Package + hash
// ============================================================================

function writeGtfsFiles(gtfs) {
  writeFileSync(join(outputDir, 'agency.txt'), gtfs.agencyTxt);
  writeFileSync(join(outputDir, 'routes.txt'), gtfs.routesTxt);
  writeFileSync(join(outputDir, 'stops.txt'), gtfs.stopsTxt);
  writeFileSync(join(outputDir, 'calendar.txt'), gtfs.calendarTxt);
  writeFileSync(join(outputDir, 'trips.txt'), gtfs.tripsTxt);
  writeFileSync(join(outputDir, 'stop_times.txt'), gtfs.stopTimesTxt);
}

function computeHash(gtfs) {
  const combined = [
    gtfs.agencyTxt, gtfs.routesTxt, gtfs.stopsTxt,
    gtfs.calendarTxt, gtfs.tripsTxt, gtfs.stopTimesTxt,
  ].join('\n---\n');
  return createHash('sha256').update(combined).digest('hex');
}

async function createZip() {
  const { default: archiver } = await import('archiver');
  const zipPath = join(outputDir, `agency-${agencyId}-gtfs.zip`);
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    archive.pipe(output);
    for (const file of ['agency.txt', 'routes.txt', 'stops.txt', 'calendar.txt', 'trips.txt', 'stop_times.txt']) {
      archive.file(join(outputDir, file), { name: file });
    }
    archive.finalize();
  });
}

/**
 * Generate the CompactSchedulePayload JSON — the same format the neary client
 * consumes directly (matching `src/types/schedule.ts` in the neary app). This
 * lets the neary app fetch this file directly (via Netlify proxy) instead of
 * running its own server-side ZIP → parse → compact → blob pipeline.
 *
 * The format deduplicates stop-time patterns: trips sharing the same stop
 * sequence (with offsets from trip start) share a single pattern entry.
 */
function generateCompactScheduleJson(allSchedules) {
  const patterns = [];
  const patternIndexByKey = new Map();
  const trips = {};
  const tripServiceMap = {};
  const tripRouteMap = {};
  const tripHeadsignMap = {};

  for (const schedule of allSchedules) {
    const { routeId, serviceId, departures, dir, stopSequence, headsign } = schedule;
    for (let seq = 0; seq < departures.length; seq++) {
      const depTime = departures[seq];
      const tripId = `${routeId}_${dir}_${serviceId}_${seq}_${depTime.replace(':', '')}`;
      const startSec = timeToSeconds(depTime);
      const stopTimes = interpolateStopTimes(startSec, stopSequence);
      const startMin = Math.floor(startSec / 60);

      // Build the pattern as offsets from trip start (minutes)
      const patternStops = stopSequence.map((stop, i) => ({
        s: stop.stopId,
        q: i,
        a: Math.round((stopTimes[i] - startSec) / 60),
        d: Math.round((stopTimes[i] - startSec) / 60),
      }));

      // Dedupe key: stop_id sequence + offsets
      const key = patternStops.map(p => `${p.s},${p.q},${p.a},${p.d}`).join(';');
      let patternIdx = patternIndexByKey.get(key);
      if (patternIdx === undefined) {
        patternIdx = patterns.length;
        patterns.push(patternStops);
        patternIndexByKey.set(key, patternIdx);
      }

      trips[tripId] = { p: patternIdx, t: startMin, s: serviceId, r: routeId, h: headsign };
      tripServiceMap[tripId] = serviceId;
      tripRouteMap[tripId] = routeId;
      if (headsign) tripHeadsignMap[tripId] = headsign;
    }
  }

  // Calendar: read from the generated calendar.txt (already in memory as gtfs object)
  const today = new Date();
  const startDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}01`;
  const endMonth = new Date(today.getFullYear(), today.getMonth() + 6, 0);
  const endDate = `${endMonth.getFullYear()}${String(endMonth.getMonth() + 1).padStart(2, '0')}${String(endMonth.getDate()).padStart(2, '0')}`;

  const calendar = [
    { serviceId: 'LV', monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false, startDate, endDate },
    { serviceId: 'S', monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: true, sunday: false, startDate, endDate },
    { serviceId: 'D', monday: false, tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: true, startDate, endDate },
    { serviceId: 'LD', monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: true, sunday: true, startDate, endDate },
  ];

  return {
    version: new Date().toISOString(),
    agencyId: Number(agencyId),
    patterns,
    trips,
    calendar,
    calendarExceptions: [],
  };
}

function writeCompactJson(allSchedules) {
  const compact = generateCompactScheduleJson(allSchedules);
  const jsonPath = join(outputDir, `agency-${agencyId}-schedule.json`);
  writeFileSync(jsonPath, JSON.stringify(compact));
  LOG(`Compact JSON: ${patterns_trips_summary(compact)}`);
  return jsonPath;
}

function patterns_trips_summary(compact) {
  return `${compact.patterns.length} patterns, ${Object.keys(compact.trips).length} trips`;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Fetch + parse all CSVs
  const allSchedules = [];
  let fetched = 0;
  let skipped = 0;

  for (const route of routeRegistry.routes) {
    for (const svcKey of SERVICE_IDS) {
      const csv = await fetchCsv(route.shortName, svcKey);
      if (!csv) { skipped++; continue; }

      const parsed = parseCsv(csv);
      if (!parsed) { skipped++; continue; }

      const serviceId = SERVICE_MAP[svcKey];

      // Resolve stop sequences from the registry
      // Direction 0: find the trip for this route with direction_id=0
      const tripDir0 = tripRegistry.trips.find(t => t.routeId === route.routeId && t.directionId === 0);
      const tripDir1 = tripRegistry.trips.find(t => t.routeId === route.routeId && t.directionId === 1);

      // Direction 0
      if (tripDir0 && stopTimesRegistry.stopTimes[tripDir0.tripId] && parsed.departures.dir0.length > 0) {
        allSchedules.push({
          routeId: route.routeId,
          serviceId,
          departures: parsed.departures.dir0,
          dir: 0,
          stopSequence: stopTimesRegistry.stopTimes[tripDir0.tripId],
          headsign: tripDir0.headsign || parsed.outStopName,
        });
      }

      // Direction 1 (may not exist for circular/one-way routes)
      if (tripDir1 && stopTimesRegistry.stopTimes[tripDir1.tripId] && parsed.departures.dir1.length > 0) {
        allSchedules.push({
          routeId: route.routeId,
          serviceId,
          departures: parsed.departures.dir1,
          dir: 1,
          stopSequence: stopTimesRegistry.stopTimes[tripDir1.tripId],
          headsign: tripDir1.headsign || parsed.inStopName,
        });
      }

      // Fallback: if no direction match in Tranzy trips but CSV has data,
      // try using dir 0 for both columns (some routes are circular and only
      // have a single trip in Tranzy but the CSV shows two columns)
      if (!tripDir0 && !tripDir1 && (parsed.departures.dir0.length > 0 || parsed.departures.dir1.length > 0)) {
        LOG(`  ⚠ Route ${route.shortName}: no trips in Tranzy registry, skipping`);
      }

      fetched++;
    }
  }

  LOG(`Fetched ${fetched} CSVs, skipped ${skipped} (no data/errors)`);
  LOG(`Generated ${allSchedules.length} schedule entries (route × direction × service day)`);

  // Task 4: Report which routes had no CSV data at all
  const routesWithData = new Set(allSchedules.map(s => s.routeId));
  const routesWithoutData = routeRegistry.routes.filter(r => !routesWithData.has(r.routeId));
  if (routesWithoutData.length > 0) {
    LOG(`Routes without schedule data (${routesWithoutData.length}):`);
    for (const r of routesWithoutData) {
      LOG(`  - ${r.shortName} (route_id=${r.routeId}) ${r.longName}`);
    }
    // Write to a file for CI visibility
    const missingReport = routesWithoutData.map(r => `${r.shortName}\t${r.routeId}\t${r.longName}`).join('\n');
    writeFileSync(join(outputDir, 'MISSING_ROUTES.txt'), `Routes without CSV schedule data:\n${missingReport}\n`);
  }

  if (allSchedules.length === 0) {
    LOG('ERROR: No schedule data collected. Aborting.');
    process.exit(1);
  }

  // Generate GTFS
  const gtfs = generateGtfs(allSchedules);
  writeGtfsFiles(gtfs);

  // Compute hash
  const hash = computeHash(gtfs);
  LOG(`Content hash: ${hash}`);

  // Check previous hash
  const hashFile = join(outputDir, 'HASH');
  const previousHash = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : '';

  if (hash === previousHash) {
    LOG('No schedule changes detected — skipping release.');
  } else {
    writeFileSync(hashFile, hash);
    writeFileSync(join(outputDir, 'CHANGED'), `Hash changed: ${previousHash || '(none)'} → ${hash}\n`);
    LOG('Schedule data CHANGED — will publish new release.');
  }

  // Create ZIP + compact JSON
  const zipPath = await createZip();
  LOG(`ZIP created: ${zipPath}`);

  const jsonPath = writeCompactJson(allSchedules);
  LOG(`JSON created: ${jsonPath}`);

  // Summary
  const tripCount = gtfs.tripsTxt.split('\n').length - 1;
  const stopTimeCount = gtfs.stopTimesTxt.split('\n').length - 1;
  LOG(`Summary: ${tripCount} trips, ${stopTimeCount} stop_times`);
  LOG('Done.');
}

main().catch(err => {
  console.error('[neary-gtfs] FATAL:', err.message);
  process.exit(1);
});
