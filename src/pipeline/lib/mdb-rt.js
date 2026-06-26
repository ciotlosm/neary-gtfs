/**
 * mdb-rt.js — resolve GTFS-RT URLs for a feed via MobilityData's catalog.
 *
 * Transitous's `ro.json` lists RT feeds as siblings (same `name`,
 * `spec: "gtfs-rt"`, with an `mdb-id`). The mdb-id points at a catalog
 * file under https://github.com/MobilityData/mobility-database-catalogs
 * (`catalogs/sources/gtfs/realtime/<provider-slug>-rt-<type>-<id>.json`),
 * which carries the actual `urls.direct_download`.
 *
 * We resolve in two steps:
 *   1. Fetch the repo's git tree once (single API call, cached for the
 *      lifetime of the pipeline run) → list of all RT catalog filenames.
 *   2. For each mdb-id we care about, find the file ending in `-<id>.json`,
 *      fetch its JSON, read `urls.direct_download` + `entity_type`.
 *
 * Maps the catalog's entity_type codes to our realtime field names:
 *   vp → vehicle_positions
 *   tu → trip_updates
 *   sa → service_alerts
 *
 * Auth: optionally honors GITHUB_TOKEN (set in CI for higher rate limit).
 * Without a token: 60 requests/hour to api.github.com — well under our
 * 1-call-per-run usage.
 */

const TREE_URL = 'https://api.github.com/repos/MobilityData/mobility-database-catalogs/git/trees/main?recursive=1';
const RAW_BASE = 'https://raw.githubusercontent.com/MobilityData/mobility-database-catalogs/main';

const ENTITY_TYPE_TO_FIELD = {
  vp: 'vehicle_positions',
  tu: 'trip_updates',
  sa: 'service_alerts',
};

function ghHeaders() {
  const h = {
    'User-Agent': 'neary-gtfs/2.0 (https://github.com/ciotlosm/neary-gtfs)',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

let _treeCache = null;
async function getRtCatalogPaths() {
  if (_treeCache) return _treeCache;
  const res = await fetch(TREE_URL, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`MDB tree fetch failed: HTTP ${res.status}`);
  const tree = await res.json();
  _treeCache = tree.tree
    .filter((n) => n.type === 'blob'
      && n.path.startsWith('catalogs/sources/gtfs/realtime/')
      && n.path.endsWith('.json'))
    .map((n) => n.path);
  return _treeCache;
}

/**
 * Build a `realtime` object from a set of mdb-ids.
 *
 * @param {Array<string>} mdbIds e.g. ['mdb-2612', 'mdb-2613', 'mdb-2614'] or ['2612', ...]
 * @returns {Promise<{ vehicle_positions?, trip_updates?, service_alerts? } | null>}
 */
export async function realtimeFromMdb(mdbIds) {
  if (!mdbIds || mdbIds.length === 0) return null;
  const paths = await getRtCatalogPaths();

  const out = {};
  for (const raw of mdbIds) {
    const id = String(raw).replace(/^mdb-/, '');
    const suffix = `-${id}.json`;
    const path = paths.find((p) => p.endsWith(suffix));
    if (!path) {
      console.warn(`[mdb-rt] no catalog file ending with ${suffix}`);
      continue;
    }
    const res = await fetch(`${RAW_BASE}/${path}`, { headers: { 'User-Agent': 'neary-gtfs/2.0' } });
    if (!res.ok) {
      console.warn(`[mdb-rt] fetch ${path}: HTTP ${res.status}`);
      continue;
    }
    const entry = await res.json();
    const url = entry.urls?.direct_download;
    const field = ENTITY_TYPE_TO_FIELD[entry.entity_type?.[0]];
    if (!url || !field) {
      console.warn(`[mdb-rt] ${path}: unusable (entity_type=${JSON.stringify(entry.entity_type)} url=${url ? 'yes' : 'no'})`);
      continue;
    }
    out[field] = url;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Convenience: from a Transitous `sources[]` array, find the RT siblings
 * matching `feedName` and resolve them.
 */
export async function resolveRealtimeForName(transitousSources, feedName) {
  const rtSiblings = transitousSources.filter((s) =>
    s.name === feedName && s.spec === 'gtfs-rt'
    && s.type === 'mobility-database' && s['mdb-id']
  );
  if (rtSiblings.length === 0) return null;
  return realtimeFromMdb(rtSiblings.map((s) => s['mdb-id']));
}
