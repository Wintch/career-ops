// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// ArtStation Jobs — art / games / film jobs board, board-wide JSON feed:
//   https://www.artstation.com/api/v2/jobs/public/jobs.json?page=N&per_page=100
// Target list: `job_boards:`, selected with `provider: artstation`.
//
// The job pages and the HTML listing answer 403 (Cloudflare challenge) to a
// declared client, so this provider reads only the public JSON feed, which the
// site's own `robots.txt` leaves open and answers 200 without a browser User-Agent.
// The feed carries what the HTML never gives a scanner: `work_remotely`,
// `offer_relocation`, the employer's own `apply_link` and the full description.
//
// robots.txt (measured 2026-10-14): `User-agent: *` disallows only account,
// likes/follow/collection and registration paths; `/api/v2/jobs/` is not under
// any Disallow, and the jobs sitemap index is listed under `Sitemap:`. No
// Crawl-delay, no group naming ClaudeBot / anthropic-ai / Claude-Web.
//
// Job.url is the employer's own https `apply_link` when it has a real path
// (Source Indexing Policy rule 2: the shortest verifiable path to the employer);
// otherwise the ArtStation posting page `/jobs/<hash_id>`. Location reads
// "Remote" when `work_remotely`, "Relocation offered" when `offer_relocation`,
// then the posting's localities ("City, Country"), so a `location_filter` can
// match "Remote" and a content filter can look for "relocation".
//
// Empty vs broken: `data` present as an array (even empty) is an empty board; a
// missing or wrong-typed `data` THROWS (the envelope changed). A malformed row is
// skipped. Paging stops on the source's own short page (fewer rows than asked),
// never on a count already narrowed by the provider.
//
// Optional entry fields:
//   maxPages    page cap (alias max_pages; default 3, max 10); 100 postings/page

import { decodeEntities } from './_html-entities.mjs';
import { fetchJsonWithRetry, sleep } from './_http.mjs';

const FEED = 'https://www.artstation.com/api/v2/jobs/public/jobs.json';
const ORIGIN = 'https://www.artstation.com';
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 3;
const HARD_MAX_PAGES = 10;
const PAGE_DELAY_MS = 1_000;
const MAX_DESCRIPTION_CHARS = 6_000;

/** @param {unknown} v @param {number} dflt @param {number} max */
function boundedInt(v, dflt, max) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : dflt;
}

/** @type {Provider} */
export default {
  id: 'artstation',

  // Explicit-only: the board's host is not claimed by URL.
  detect(entry) {
    return entry?.provider === 'artstation' ? { url: FEED } : null;
  },

  async fetch(entry, ctx) {
    const maxPages = boundedInt(entry?.maxPages ?? entry?.max_pages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
    // A health probe (verify-portals) asks for one page; honour that.
    const pages = ctx?.maxPages && ctx.maxPages < maxPages ? ctx.maxPages : maxPages;
    const byUrl = new Map();
    for (let page = 1; page <= pages; page++) {
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, `${FEED}?page=${page}&per_page=${PAGE_SIZE}`, { redirect: 'error' });
      } catch (err) {
        if (page === 1) throw err;
        console.warn(`artstation: page ${page} failed (${err?.message || err}); keeping ${byUrl.size} posting(s) from earlier pages`);
        break;
      }
      if (!json || !Array.isArray(json.data)) {
        const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
        throw new Error(`artstation: unexpected response — expected { data: [...] }, got: [${got}]`);
      }
      for (const j of parseArtStationJobs(json.data)) if (!byUrl.has(j.url)) byUrl.set(j.url, j);
      if (json.data.length < PAGE_SIZE) break;
      if (page < pages) await sleep(PAGE_DELAY_MS, ctx);
    }
    return [...byUrl.values()];
  },
};

/** @param {unknown} v @returns {string} */
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** @param {unknown} v @returns {number | undefined} */
function epoch(v) {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

/** @param {string} html */
function plainText(html) {
  return decodeEntities(html.replace(/<(br|\/p|\/li|\/h\d)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** @param {any} j */
function locationOf(j) {
  const parts = [];
  if (j.work_remotely === true) parts.push('Remote');
  if (j.offer_relocation === true) parts.push('Relocation offered');
  const places = Array.isArray(j.recruitment_localities) ? j.recruitment_localities : [];
  for (const entry of places) {
    const loc = entry && typeof entry === 'object' ? entry.locality : null;
    if (!loc || typeof loc !== 'object') continue;
    const name = [str(loc.city_name ?? loc.name), str(loc.country_name)].filter(Boolean).join(', ');
    if (name && !parts.includes(name)) parts.push(name);
  }
  return parts.join(' · ');
}

/**
 * Normalize the `data` rows of the feed. Exported for unit tests.
 *
 * @param {any[]} rows
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number, description?: string}>}
 */
export function parseArtStationJobs(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const j of rows) {
    if (!j || typeof j !== 'object') continue;
    if (j.deleted_at || (j.job_state && j.job_state !== 'approved')) continue;
    const title = str(j.title);
    const hash = str(j.hash_id);
    if (!title || !/^[A-Za-z0-9]{3,12}$/.test(hash)) continue;
    let url = `${ORIGIN}/jobs/${hash}`;
    try {
      const apply = new URL(str(j.apply_link));
      if (apply.protocol === 'https:' && apply.pathname.replace(/\/+$/, '') !== '') url = apply.href;
    } catch {
      // no usable employer link (mailto:, bare address, empty): keep the ArtStation page
    }
    const company = str(j.company_name) || str(j.recruitment_company?.name);
    if (!company) continue;
    const job = { title, url, company, location: locationOf(j) };
    const postedAt = epoch(j.listing_placement?.posted_at) ?? epoch(j.created_at);
    if (postedAt !== undefined) job.postedAt = postedAt;
    const description = plainText(str(j.description)).slice(0, MAX_DESCRIPTION_CHARS);
    if (description) job.description = description;
    out.push(job);
  }
  return out;
}
