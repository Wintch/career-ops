// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// SoftServe careers provider — reads the JSON API behind SoftServe's own
// careers site (https://career.softserveinc.com), the one its Nuxt front end
// calls. Single-company adapter: wire in via a `tracked_companies:` entry.
//
//   - name: SoftServe
//     careers_url: https://career.softserveinc.com/en-us/vacancies/country-ukraine
//     max_pages: 30            # optional, default 30, cap 60
//
// `detect()` claims any `https://career.softserveinc.com/...` URL, whatever
// country or language page it points at; the path is discarded. The API has no
// country parameter the provider needs: the whole global inventory is ~15 pages
// of 12 and is walked in full. All countries are returned (Ukraine, Poland,
// Bulgaria, Romania, Germany, Spain, UK, UAE, USA, Mexico, Colombia and Chile
// were listed on 2026-10-11); the location column shows the country.
//
// SOURCE CHECK (measured 2026-10-11, with the scanner's declared User-Agent):
//   - `GET /api/frontend/vacancies?page=N` answers JSON with no auth:
//     `{ data: { vacancies: [...], filters }, links, meta: { total, per_page,
//     last_page } }` — 177 postings, 12 per page, page 15 short (9), page 16
//     an empty `vacancies` array;
//   - each vacancy carries id, urlSegment, name, city ("Colombia; Chile"),
//     direction, level and tags — no date and no description;
//   - the posting page is `/en-us/vacancies/{urlSegment}` (200, server-rendered);
//   - robots.txt, re-checked 2026-10-12 with the scanner's DEFAULT_USER_AGENT:
//     only a `User-agent: *` group exists; no group names ClaudeBot,
//     anthropic-ai, Claude-Web or Claude-User — result: allowed. It
//     disallows */login*, */linkedin*, */?admin*, */recovery, */registration*,
//     */successful*, */set/*, */oauth/*, */q-, */query and
//     */_Incapsula_Resource* — neither the API path nor the posting pages;
//   - termination follows `meta.last_page` / `meta.per_page` when present,
//     falling back to a 12-row short page.

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const ORIGIN = 'https://career.softserveinc.com';
/** Fallback page size when `meta.per_page` is absent. */
const PAGE_SIZE = 12;
const DEFAULT_MAX_PAGES = 30;
/** Hard ceiling on a configured `max_pages` — independent of what the source reports. */
const MAX_PAGES_CAP = 60;
const INTER_PAGE_DELAY_MS = 250;

/**
 * True for an https URL on SoftServe's careers host.
 * @param {any} raw
 * @returns {boolean}
 */
export function isSoftServeUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'career.softserveinc.com';
}

/** @param {any} v @returns {string} */
const str = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/**
 * Normalize one API page. Throws when the envelope is not the documented
 * `data.vacancies[]` shape; a malformed row is skipped.
 * @param {any} json
 * @returns {{ jobs: import('./_types.js').Job[], rawCount: number }}
 */
export function parseVacanciesPage(json) {
  const rows = json && typeof json === 'object' && json.data && Array.isArray(json.data.vacancies)
    ? json.data.vacancies
    : null;
  if (!rows) {
    const got = json && typeof json === 'object'
      ? `${Object.keys(json).join(', ')}${json.data && typeof json.data === 'object' ? ` / data: ${Object.keys(json.data).join(', ')}` : ''}`
      : typeof json;
    throw new Error(`softserve: unexpected API response — expected data.vacancies[], got: [${got}]`);
  }

  /** @type {import('./_types.js').Job[]} */
  const jobs = [];
  for (const v of rows) {
    if (!v || typeof v !== 'object') continue;
    const title = str(v.name);
    const segment = typeof v.urlSegment === 'string' && v.urlSegment.trim() ? safeEncodeURIComponent(v.urlSegment.trim()) : null;
    if (!title || !segment || /^\.+$/.test(v.urlSegment.trim())) continue;
    const city = str(v.city).split(/\s*;\s*/).filter(Boolean).join(', ');
    const tags = Array.isArray(v.tags) ? v.tags.map((/** @type {any} */ t) => str(t?.name)).filter(Boolean) : [];
    const id = typeof v.id === 'number' || typeof v.id === 'string' ? String(v.id) : '';
    jobs.push({
      title,
      url: `${ORIGIN}/en-us/vacancies/${segment}`,
      company: 'SoftServe',
      location: [city, ...tags].filter(Boolean).join(' · '),
      ...(id ? { externalId: id } : {}),
    });
  }
  return { jobs, rawCount: rows.length };
}

/** @type {Provider} */
export default {
  id: 'softserve',

  detect(entry) {
    if (entry?.provider === 'softserve') return { url: `${ORIGIN}/en-us/vacancies` };
    return isSoftServeUrl(entry?.careers_url) || isSoftServeUrl(entry?.api) ? { url: `${ORIGIN}/en-us/vacancies` } : null;
  },

  async fetch(entry, ctx) {
    const entryMax = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, MAX_PAGES_CAP)
      : DEFAULT_MAX_PAGES;
    const ctxMax = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const probing = Number.isFinite(ctxMax);
    const maxPages = Math.min(entryMax, ctxMax);

    /** @type {import('./_types.js').Job[]} */
    const jobs = [];
    const seen = new Set();
    let stopReason = 'complete';
    /** @param {any} v */
    const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : 0);

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const json = await fetchJsonWithRetry(ctx, `${ORIGIN}/api/frontend/vacancies?page=${page}`, {
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      const { jobs: parsed, rawCount } = parseVacanciesPage(json);
      for (const job of parsed) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      // The source's own end: an empty or short page (raw count, never the
      // filtered one), or meta.last_page reached.
      const perPage = posInt(json?.meta?.per_page) || PAGE_SIZE;
      const lastPage = posInt(json?.meta?.last_page);
      if (rawCount === 0 || rawCount < perPage) break;
      if (lastPage && page >= lastPage) break;
      if (page === maxPages) stopReason = probing ? 'probe' : 'cap';
    }

    if (stopReason === 'cap') {
      console.warn(entryMax === MAX_PAGES_CAP
        ? `softserve: reached the ${MAX_PAGES_CAP}-page cap with more vacancies available — the source is larger than this provider reads`
        : `softserve: stopped at max_pages=${maxPages} with more vacancies available — raise max_pages on this entry`);
    }
    return jobs;
  },
};
