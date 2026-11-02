// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Mercor provider — the public listings of work.mercor.com, Mercor's own
// marketplace of hourly and project contracts (AI-training and expert work for
// AI labs, plus engineering engagements). Mercor is the contracting party, so
// this is a single-source adapter: one `tracked_companies:` entry, e.g.
//
//   - name: Mercor
//     careers_url: https://work.mercor.com/explore
//
// Auto-detects from a `careers_url` / `api` on the https `work.mercor.com` host
// (any path: the explore page, a posting permalink, the bare host).
//
// The explore page is server-rendered by Next.js and ships the whole public
// inventory in its `__NEXT_DATA__` blob (React Query dehydrated state), so ONE
// request returns every listing with title, markdown description, eligible and
// ineligible countries (ISO 3166-1 alpha-3), pay rate and posting date — zero
// per-posting requests, zero tokens:
//
//   props.pageProps.dehydratedState.queries[] — the query whose key starts with
//   "listings-explore-page" — .state.data.listings[] = { listingId, title,
//   description, status, isPrivate, disableApplications, location,
//   workArrangement, eligibleLocation, eligibleResidenceLocation,
//   ineligibleLocation, ineligibleResidenceLocation, rateMin, rateMax,
//   payRateFrequency, hoursPerWeek, commitment, companyName,
//   companyBrandVisible, postedAt, createdAt }
//
// Observed 2026-11-02: 316 listings in a 1.3 MB page. `robots.txt` disallows
// `/api/`, `/apply/` and account routes; `/explore` and `/jobs/<id>/<slug>` are
// allowed. The provider never touches the JSON API.
//
// Posting URL: `https://work.mercor.com/jobs/<listingId>`. The site answers any
// slug (or none) with a 308 to the canonical `/jobs/<listingId>/<title-slug>`,
// so the slug-less form opens the right page in a browser and, unlike a slug
// rebuilt from the title, stays the same dedup key when a title is edited.
//
// Location: the listing's own `location` text, followed by the eligible
// countries as English names — "Remote (eligible: United States)" — so a
// location_filter written with country names can match. Ineligible countries
// are left out of the location (a country named there would read as allowed)
// and go at the top of the description instead, with the pay line and the
// client's name when Mercor shows it.
//
// Compensation is NOT mapped to `salary`: most listings pay by the hour or per
// task, and `salary` is annualized and "never inferred". The pay line in the
// description carries the figures as published.

import { fetchTextWithRetry } from './_http.mjs';
import { countryNameFromIso } from './_country.mjs';

const MERCOR_HOST = 'work.mercor.com';
const EXPLORE_URL = `https://${MERCOR_HOST}/explore`;
// Listing ids are base64url-shaped (`list_AAABoRePE1qiY1-aJqFLRrSi`). Anything
// else is dropped rather than encoded: the id is the whole URL path segment.
const LISTING_ID_RE = /^list_[A-Za-z0-9_-]+$/;
const QUERY_KEY = 'listings-explore-page';

/**
 * Claim an entry on the https work.mercor.com host. Only the host is a trust
 * boundary: the request always goes to the fixed explore URL, never to the
 * entry's own path.
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {boolean}
 */
function isMercorEntry(entry) {
  for (const raw of [entry?.api, entry?.careers_url]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const parsed = new URL(raw.trim());
      if (parsed.protocol === 'https:' && parsed.hostname === MERCOR_HOST) return true;
    } catch { /* not a URL */ }
  }
  return false;
}

/**
 * Mercor's timestamps carry no zone (`2026-10-07T18:10:15`); the JSON-LD on the
 * posting pages gives the same instant with a `Z`, so they are UTC.
 * @param {unknown} value
 * @returns {number | undefined}
 */
function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Country names for a list of ISO codes, deduped, unknown codes kept as given.
 * @param {...unknown} lists
 * @returns {string[]}
 */
function countryNames(...lists) {
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const code of list) {
      if (typeof code !== 'string' || !code.trim()) continue;
      const name = countryNameFromIso(code) || code.trim();
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** @param {unknown} s */
const text = (s) => (typeof s === 'string' ? s.trim() : '');

/**
 * @param {any} l
 * @returns {string}
 */
function locationOf(l) {
  let base = text(l.location);
  if (!base) base = l.workArrangement === 'remote' ? 'Remote' : text(l.workArrangement);
  const eligible = countryNames(l.eligibleLocation, l.eligibleResidenceLocation);
  if (!eligible.length) return base;
  return base ? `${base} (eligible: ${eligible.join(', ')})` : `Eligible: ${eligible.join(', ')}`;
}

/**
 * "USD 70-90/hour, 20 h/week" from the listing's own figures; '' when absent.
 * @param {any} l
 * @returns {string}
 */
function payOf(l) {
  const min = Number.isFinite(l.rateMin) && l.rateMin > 0 ? l.rateMin : null;
  const max = Number.isFinite(l.rateMax) && l.rateMax > 0 ? l.rateMax : null;
  if (min === null && max === null) return '';
  const range = min !== null && max !== null && min !== max ? `${min}-${max}` : String(min ?? max);
  const per = { hourly: '/hour', yearly: '/year', 'per-task': ' per task', 'one-time': ' one-time' }[l.payRateFrequency] ?? '';
  const hours = Number.isFinite(l.hoursPerWeek) && l.hoursPerWeek > 0 ? `, ${l.hoursPerWeek} h/week` : '';
  return `USD ${range}${per}${hours}`;
}

/**
 * @param {any} l
 * @returns {string}
 */
function descriptionOf(l) {
  const head = [];
  const pay = payOf(l);
  if (pay) head.push(`Pay: ${pay}`);
  if (text(l.commitment)) head.push(`Commitment: ${text(l.commitment)}`);
  if (l.companyBrandVisible && text(l.companyName)) head.push(`Client: ${text(l.companyName)}`);
  const ineligible = countryNames(l.ineligibleLocation, l.ineligibleResidenceLocation);
  if (ineligible.length) head.push(`Not eligible: ${ineligible.join(', ')}`);
  const body = text(l.description);
  return [head.join('\n'), body].filter(Boolean).join('\n\n');
}

/** @type {Provider} */
export default {
  id: 'mercor',

  detect(entry) {
    return isMercorEntry(entry) ? { url: EXPLORE_URL } : null;
  },

  async fetch(entry, ctx) {
    if (!isMercorEntry(entry)) throw new Error(`mercor: ${entry?.name} is not a https://${MERCOR_HOST} entry`);
    const html = await fetchTextWithRetry(ctx, EXPLORE_URL, { redirect: 'error' });
    return parseMercorExplore(html, { company: entry.name });
  },
};

/**
 * Parse the explore page. Exported for unit tests.
 *
 * - `[]` — the listings array is present and empty.
 * - throws — no `__NEXT_DATA__`, unparseable JSON, no listings query, or a
 *   `listings` value that is not an array (a markup change, never a zero).
 * - a malformed, inactive, private or closed listing is dropped, never fatal.
 *
 * @param {string} html
 * @param {{company: string}} opts
 * @returns {Array<import('./_types.js').Job>}
 */
export function parseMercorExplore(html, { company }) {
  if (typeof html !== 'string' || !html) throw new Error('mercor: empty response body');
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('mercor: explore page carries no __NEXT_DATA__ — markup changed?');
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (err) {
    throw new Error(`mercor: __NEXT_DATA__ is not valid JSON — ${/** @type {Error} */ (err).message}`);
  }
  const queries = data?.props?.pageProps?.dehydratedState?.queries;
  if (!Array.isArray(queries)) throw new Error('mercor: no dehydratedState.queries in __NEXT_DATA__ — markup changed?');
  const query = queries.find((q) => Array.isArray(q?.queryKey) && q.queryKey[0] === QUERY_KEY);
  if (!query) throw new Error(`mercor: no "${QUERY_KEY}" query in __NEXT_DATA__ — markup changed?`);
  const listings = query?.state?.data?.listings;
  if (!Array.isArray(listings)) throw new Error(`mercor: listings is ${listings === null ? 'null' : typeof listings}, not an array`);

  const out = [];
  for (const l of listings) {
    if (!l || typeof l !== 'object') continue;
    const title = text(l.title);
    const id = typeof l.listingId === 'string' && LISTING_ID_RE.test(l.listingId) ? l.listingId : null;
    if (!title || !id) continue;
    if ((l.status && l.status !== 'active') || l.deletedAt || l.isPrivate === true || l.disableApplications === true) continue;
    const description = descriptionOf(l);
    out.push({
      title,
      url: `https://${MERCOR_HOST}/jobs/${id}`,
      company,
      location: locationOf(l),
      postedAt: toEpochMs(l.postedAt) ?? toEpochMs(l.createdAt),
      externalId: id,
      ...(description ? { description } : {}),
    });
  }
  return out;
}
