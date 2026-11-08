// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// EPAM Systems provider — single-company (pattern: aldi-nord/ibm/dassault), for
// `tracked_companies:` entries. It reads the job search API that
// careers.epam.com's own search page calls:
//
//   GET https://careers.epam.com/api/jobs/v2/search/careers?size=50&from=N
//   → {"data":{"total":707,"jobs":[...],"facets":{...}},"meta":{...}}
//
// No cookie, token or login. Paging is by OFFSET: `from` is the row offset and
// `size` is capped at 50 by the server (a larger value still returns 50). A
// `page` parameter exists in the URLs people copy around but the server
// ignores it and answers the first rows every time, so a walk keyed on `page`
// reads the same 50 postings over and over (measured 2026-11-08: 20 requests,
// 1,000 rows, 50 distinct). The walk here uses `from` and stops at `data.total`,
// on a short or empty page, or at max_pages; it also drops repeated rows by
// posting URL (which embeds the `uid`), so a posting the source repeats is
// never emitted twice. A failure after page one keeps the pages already read
// and warns; only the first page's failure fails the board.
//
// One public page per posting: https://careers.epam.com{seo.url}, the
// `/en/vacancy/{title-slug}-{uid}_en` path the payload carries for each row and
// the site's own result cards link to (a sample returned 200 with the scanner's
// client). A row with no usable `seo.url` falls back to `/en/vacancy/{uid}_en`,
// which the site also serves.
//
// The list payload carries the job text for free (`description`, plus the
// `category` responsibility/requirement lists), so `description` is filled from
// it with no per-posting request. `created_at` becomes `postedAt`. The source
// has no requisition number worth keeping (`sd_requisition_id` is null on the
// rows measured): `requisitionId` is set only when the field is present.
//
// Location: the cities when the row names them, else the countries, then the
// work mode (`vacancy_type`: Remote / Hybrid / Office) after a " · " separator,
// so a remote posting open to Argentina reads "Argentina, Chile · Remote".
//
// Policy: single-company adapter (Source Indexing Policy, section 1). The API
// path and `?query` / `?page` URLs are disallowed in careers.epam.com's
// robots.txt; since rule 6 was rewritten (docs/SOURCE_INDEXING_LOG.md, "Rule 6
// changed (2026-11-08)") robots.txt is not a gate, and the provider reads only
// what a signed-out visitor's browser reads, with at most 15 list requests per
// run (default) spaced INTER_REQUEST_DELAY_MS apart, and builds no index.
//
// Entry config: max_pages counts 50-row pages (default DEFAULT_MAX_PAGES, at
// most MAX_PAGES_CAP).

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { coerceId } from './_ids.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const HOST = 'careers.epam.com';
const API_URL = `https://${HOST}/api/jobs/v2/search/careers`;
const PAGE_SIZE = 50; // the server's own cap
// 15 pages = 750 rows, just above the 707 measured on 2026-11-08.
const DEFAULT_MAX_PAGES = 15;
const MAX_PAGES_CAP = 60;
const INTER_REQUEST_DELAY_MS = 400;
const COMPANY = 'EPAM Systems';
// `/en/vacancy/{slug}-{uid}_en`: the one path shape the provider will link to.
const VACANCY_PATH_RE = /^\/en\/vacancy\/[A-Za-z0-9._~%-]+$/;

/** @param {any} entry */
function entryUrl(entry) {
  if (typeof entry?.careers_url === 'string' && entry.careers_url) return entry.careers_url;
  if (typeof entry?.api === 'string' && entry.api) return entry.api;
  return null;
}

/**
 * @param {unknown} raw
 * @returns {boolean} true for an https URL on careers.epam.com itself
 */
export function isEpamUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.hostname.toLowerCase() === HOST;
}

/** @param {any} entry */
export function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** @param {unknown} value */
function toEpochMs(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value.trim());
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Cities (as "City, Country") when the row names them, else the distinct
 * countries; then " · Remote" / " · Hybrid" from `vacancy_type`. An on-site
 * posting carries no marker. A remote row with no place reads just "Remote".
 * A Remote row that names a city keeps the other countries it lists after the
 * city ("Bogota, Colombia, Mexico, Brazil · Remote"): the city is where the
 * recruiter sits, the countries are where the role is open, and a
 * location_filter must still see all of them. A Hybrid or Office row stays
 * tied to its cities.
 * @param {any} row
 */
export function formatLocation(row) {
  const places = [];
  const cityCountries = new Set();
  for (const c of Array.isArray(row?.city) ? row.city : []) {
    const name = text(c?.name);
    const country = text(c?.country?.name);
    if (country) cityCountries.add(country);
    const place = [name, country].filter(Boolean).join(', ');
    if (place && !places.includes(place)) places.push(place);
  }
  const mode = text(row?.vacancy_type);
  const marker = /^(remote|hybrid)$/i.test(mode) ? mode[0].toUpperCase() + mode.slice(1).toLowerCase() : '';
  if (places.length === 0 || /^remote$/i.test(mode)) {
    for (const c of Array.isArray(row?.country) ? row.country : []) {
      const name = text(c?.name);
      if (name && !cityCountries.has(name) && !places.includes(name)) places.push(name);
    }
  }
  return [places.join(', '), marker].filter(Boolean).join(' · ');
}

/**
 * The posting's public page, from the row's own `seo.url`; the `{uid}_en` form
 * when that is missing or not the expected shape. null when neither is usable.
 * @param {any} row
 * @returns {string | null}
 */
export function buildPostingUrl(row) {
  const seo = typeof row?.seo?.url === 'string' ? row.seo.url.trim() : '';
  if (VACANCY_PATH_RE.test(seo)) return `https://${HOST}${seo}`;
  const uid = typeof row?.uid === 'string' ? safeEncodeURIComponent(row.uid.trim()) : null;
  return uid ? `https://${HOST}/en/vacancy/${uid}_en` : null;
}

/**
 * The job text the list payload carries: the intro, then responsibilities,
 * requirements and nice-to-haves, as plain text.
 * @param {any} row
 */
function buildDescription(row) {
  const parts = [htmlToText(row?.description, { cap: Infinity })];
  const cat = row?.category && typeof row.category === 'object' ? row.category : {};
  for (const [label, key] of [['Responsibilities', 'responsibilities'], ['Requirements', 'requirements'], ['Nice to have', 'nice_to_have']]) {
    const items = Array.isArray(cat[key]) ? cat[key].map((s) => htmlToText(s, { cap: Infinity })).filter(Boolean) : [];
    if (items.length > 0) parts.push(`${label}: ${items.join('; ')}`);
  }
  return htmlToText(parts.filter(Boolean).join(' '));
}

/**
 * One response → its postings and the source's own counts. A body that is not
 * the documented envelope throws; a malformed, expired or hidden row is skipped.
 * `rawCount` is the source's row count for the page, before any drop.
 * @param {any} json
 * @returns {{ jobs: import('./_types.js').Job[], rawCount: number, total: number | null }}
 */
export function parseSearchResponse(json) {
  const rows = json && typeof json === 'object' && json.data && Array.isArray(json.data.jobs) ? json.data.jobs : null;
  if (!rows) {
    const got = json && typeof json === 'object'
      ? Object.keys(json.data && typeof json.data === 'object' ? json.data : json).join(', ')
      : typeof json;
    throw new Error(`epam: unexpected response — expected data.jobs[], got: [${got}]`);
  }
  const jobs = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.is_expired === true || row.is_hidden === true) continue;
    const title = text(row.name);
    const url = buildPostingUrl(row);
    if (!title || !url) continue;
    /** @type {import('./_types.js').Job} */
    const job = {
      title,
      url,
      company: COMPANY,
      location: formatLocation(row),
    };
    const postedAt = toEpochMs(row.created_at);
    if (postedAt !== undefined) job.postedAt = postedAt;
    const description = buildDescription(row);
    if (description) job.description = description;
    const requisitionId = coerceId(row.sd_requisition_id);
    if (requisitionId) job.requisitionId = requisitionId;
    jobs.push(job);
  }
  const total = Number.isInteger(json.data.total) && json.data.total >= 0 ? json.data.total : null;
  return { jobs, rawCount: rows.length, total };
}

/** @type {Provider} */
export default {
  id: 'epam',

  detect(entry) {
    const url = entryUrl(entry);
    return url && isEpamUrl(url) ? { url } : null;
  },

  async fetch(entry, ctx) {
    // Only the host is a trust boundary; the API URL is a fixed literal.
    const url = entryUrl(entry);
    if (url && !isEpamUrl(url)) throw new Error(`epam: ${entry?.name ?? '(unnamed)'} is not on ${HOST}`);

    const maxPages = resolveMaxPages(entry);
    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = Number.isInteger(ctxMaxPages) && ctxMaxPages > 0;
    const pageBudget = probing ? Math.min(maxPages, ctxMaxPages) : maxPages;

    const jobs = [];
    const seenUrls = new Set();
    let offset = 0;
    for (let page = 1; page <= pageBudget; page++) {
      if (page > 1) await sleep(INTER_REQUEST_DELAY_MS, ctx);
      let result;
      try {
        const json = await fetchJsonWithRetry(ctx, `${API_URL}?size=${PAGE_SIZE}&from=${offset}`, {
          redirect: 'error',
          headers: { accept: 'application/json' },
        });
        result = parseSearchResponse(json);
      } catch (err) {
        // A failed or reshaped first page is a broken board, not an empty one,
        // and a probe needs the rejection unwrapped. Past page one in a real
        // scan, keep the pages already read and say so.
        if (page === 1 || probing) throw err;
        console.error(`⚠️  epam: truncated at page ${page} (${jobs.length} postings): ${err.message}`);
        break;
      }
      for (const job of result.jobs) {
        if (seenUrls.has(job.url)) continue;
        seenUrls.add(job.url);
        jobs.push(job);
      }
      offset += result.rawCount;
      // The source's own page shape decides, never the narrowed count.
      if (result.rawCount < PAGE_SIZE) break;
      if (result.total !== null && offset >= result.total) break;
      if (page === pageBudget && !probing) {
        console.error(`⚠️  epam: truncated at max_pages=${maxPages} (${offset} of ${result.total ?? '?'} postings) — raise max_pages on this entry`);
      }
    }
    return jobs;
  },
};
