/**
 * resolve-feeds.js — produce the ordered list of feeds this run will build.
 *
 * Two sources:
 *
 *   1. **Local feeds** — each subdirectory of `feeds/` with a `config.json`
 *      is a feed we build ourselves. Auto-discovered (no JS edits needed
 *      to add another local feed). `config.json` must declare at least
 *      `id`, `name`, `country`, plus a `build` block consumed by the
 *      feed's own `build.js` (see feeds/ctp-cluj/config.json for shape).
 *
 *   2. **Transitous mirrors** — for each ISO code in `countries.json`,
 *      fetch `feeds/<iso>.json` from public-transport/transitous@main and
 *      mirror the entries whose `name` appears in `countries.json`'s
 *      `include[]` whitelist. Their .zip comes from
 *      `api.transitous.org/gtfs/<iso>_<name>.gtfs.zip`.
 *
 * Local feeds are emitted before Transitous mirrors so they appear first
 * in `outputs/feeds.json` (UX nicety; the app picks by GPS bbox anyway).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const FEEDS_DIR = join(ROOT, 'feeds');

const TRANSITOUS_RAW = 'https://raw.githubusercontent.com/public-transport/transitous/main/feeds';

// ───────────────────────────────────────────────────────────────────────────
// Local feeds (auto-discovered from feeds/<id>/config.json)
// ───────────────────────────────────────────────────────────────────────────

function loadLocalFeeds() {
  if (!existsSync(FEEDS_DIR)) return [];
  const out = [];
  for (const entry of readdirSync(FEEDS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = join(FEEDS_DIR, entry.name, 'config.json');
    if (!existsSync(cfgPath)) continue;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    out.push({
      id: cfg.id ?? entry.name,
      name: cfg.name,
      country: cfg.country,
      region: cfg.region ?? null,
      timezone: cfg.timezone ?? null,
      languages: cfg.languages ?? [],
      source: { type: 'build', publisher: 'neary-gtfs', upstream_url: null },
      // agencies[] is intentionally empty — derive-bbox re-reads agency.txt
      // from the generated zip and that takes precedence (make-app-registry.js).
      agencies: [],
      realtime: cfg.realtime ?? null,
      tranzy: cfg.tranzy ?? null,
      license: cfg.license,
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Transitous mirrors (gated by countries.json include[] whitelist)
// ───────────────────────────────────────────────────────────────────────────

async function fetchTransitousCountry(iso) {
  const url = `${TRANSITOUS_RAW}/${iso}.json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'neary-gtfs/2.0 (https://github.com/ciotlosm/neary-gtfs)' },
  });
  if (!res.ok) throw new Error(`Transitous fetch failed for ${iso}: HTTP ${res.status}`);
  return res.json();
}

function projectTransitousFeed(iso, raw) {
  if (!raw.name) return { skip: 'missing name' };
  if (!['http', 'transitland-atlas', 'mobility-database'].includes(raw.type)) {
    return { skip: `unsupported source type: ${raw.type}` };
  }
  const id = String(raw.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return {
    feed: {
      id,
      name: raw.name,
      country: iso.toUpperCase(),
      region: null,
      timezone: null,
      languages: [],
      source: {
        type: 'transitous',
        publisher: `Transitous (${raw.type})`,
        upstream_url: raw.url ?? null,
      },
      agencies: [],
      realtime: null,
      license: {
        spdx_identifier: raw.license?.['spdx-identifier'] ?? null,
        attribution_text: raw.license?.['attribution-text'] ?? raw.name,
        attribution_url: raw.license?.['url'] ?? null,
      },
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────

export async function resolveFeeds() {
  const config = JSON.parse(readFileSync(join(ROOT, 'countries.json'), 'utf8'));
  const countries = config.countries ?? [];
  const includeWhitelist = new Set(config.include ?? []);

  const localFeeds = loadLocalFeeds();
  const localIds = new Set(localFeeds.map((f) => f.id));
  const feeds = [...localFeeds];

  for (const iso of countries) {
    let payload;
    try {
      payload = await fetchTransitousCountry(iso);
    } catch (err) {
      console.warn(`[resolve-feeds] skipping ${iso}: ${err.message}`);
      continue;
    }
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    const seen = new Set();
    for (const raw of sources) {
      if (!includeWhitelist.has(raw.name)) continue;
      const projected = projectTransitousFeed(iso, raw);
      if (projected.skip) {
        console.warn(`[resolve-feeds] ${iso}/${raw.name}: skipped (${projected.skip})`);
        continue;
      }
      // Don't double-mirror something we already build locally.
      if (localIds.has(projected.feed.id)) continue;
      if (seen.has(projected.feed.id)) continue;
      seen.add(projected.feed.id);
      feeds.push(projected.feed);
    }
  }

  console.log(`[resolve-feeds] ${feeds.length} feed(s): ${feeds.map((f) => f.id).join(', ')}`);
  return feeds;
}

