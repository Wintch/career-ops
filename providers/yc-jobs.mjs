// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// YC Jobs provider — one Y Combinator startup per entry (`tracked_companies:`).
// Reads the public per-company jobs page that Y Combinator's "Work at a
// Startup" board publishes for every company it lists:
//   https://www.ycombinator.com/companies/<slug>/jobs
// The page is server-rendered with its data embedded as JSON in the root
// element's `data-page` attribute (`props.jobPostings`), so no API key, login
// or headless browser is involved and no per-posting request is needed.
//
// Auto-detects `careers_url` values of the form
//   https://www.workatastartup.com/companies/<slug>
//   https://www.ycombinator.com/companies/<slug>[/jobs]
//
// Why per company and not the board-wide listing: the board's role/location
// pages (`/jobs/role/<role>`) return a fixed ~35-posting window that ignores
// `?page=`, so they cannot be traversed to a complete inventory. The
// per-company page lists that company's full set of open roles.
//
// Dates: the page only exposes a coarse relative age in Rails' time-ago words
// ("about 10 hours", "20 days", "2 months", "over 2 years"). `postedAt` is
// derived from it as `now - N units` (a month is 30 days, a year 365), so it
// is accurate to the unit's granularity: good enough to tell "this week" from
// "last quarter" for recency filtering, never a precise timestamp. A phrase
// that does not parse leaves `postedAt` unset rather than guessed.
// `robots.txt` on both hosts allows these paths (only `/companies?*` search
// queries are disallowed on ycombinator.com, and this provider never uses them).

import { decodeEntities } from './_html-entities.mjs';

const YC_HOSTS = new Set([
  'www.ycombinator.com',
  'ycombinator.com',
  'www.workatastartup.com',
  'workatastartup.com',
]);

// YC company slugs are lowercase alphanumerics and hyphens. Anything else is
// refused before it reaches a URL.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

const JOBS_ORIGIN = 'https://www.ycombinator.com';

/**
 * Extract the company slug from a YC / Work at a Startup careers_url.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function parseYcSlug(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!YC_HOSTS.has(parsed.hostname)) return null;
  const m = parsed.pathname.match(/^\/companies\/([^/]+)(?:\/jobs)?\/?$/);
  if (!m) return null;
  return SLUG_RE.test(m[1]) ? m[1].toLowerCase() : null;
}

const UNIT_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

/**
 * Convert a Rails-style relative age ("about 10 hours", "20 days", "2 months",
 * "over 2 years", "less than a minute") into an age in milliseconds, or null
 * when the phrase is not recognised. Exported for unit tests.
 * @param {unknown} text
 * @returns {number|null}
 */
export function parseRelativeAgeMs(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase();
  if (/^less than (a|1) minute$/.test(t)) return 0;
  const m = t.match(/^(?:about |over |almost |less than )?(\d+|an?) (second|minute|hour|day|week|month|year)s?$/);
  if (!m) return null;
  const n = /^an?$/.test(m[1]) ? 1 : Number(m[1]);
  return Number.isFinite(n) ? n * UNIT_MS[m[2]] : null;
}

/** @param {any} entry */
function resolveJobsUrl(entry) {
  const slug = parseYcSlug(entry?.careers_url);
  return slug ? `${JOBS_ORIGIN}/companies/${slug}/jobs` : null;
}

/** @type {Provider} */
export default {
  id: 'yc-jobs',

  detect(entry) {
    const url = resolveJobsUrl(entry);
    return url ? { url } : null;
  },

  async fetch(entry, ctx) {
    const url = resolveJobsUrl(entry);
    if (!url) throw new Error(`yc-jobs: cannot derive jobs URL for ${entry?.name}`);
    // redirect:'error' keeps a redirect from steering the request off-host.
    const html = await ctx.fetchText(url, { redirect: 'error' });
    return parseYcJobsPage(html, entry.name, Date.now());
  },
};

/**
 * Parse a YC company jobs page. Exported for unit tests.
 *
 * Reads `props.jobPostings` from the `data-page` JSON and maps each posting to
 * the normalized Job shape:
 *   - title:    `title`, trimmed.
 *   - url:      `https://www.ycombinator.com` + the posting's `/companies/...`
 *               path. The page's `applyUrl` is a login redirect, so it is
 *               not used.
 *   - location: `location`, trimmed ('' when absent).
 *   - postedAt: `now - age` from the page's relative `createdAt` (see header),
 *               only when `now` is given and the phrase parses.
 *   - company:  `companyName` from the posting, else the portal entry name.
 *
 * Rows without a title or a `/companies/` path are dropped (an empty URL would
 * corrupt the URL-based dedup key). A page with no `data-page` payload, or a
 * payload without `jobPostings`, yields [].
 *
 * @param {string} html
 * @param {string} companyName
 * @param {number} [now] epoch ms used to turn the relative age into `postedAt`
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseYcJobsPage(html, companyName, now) {
  if (typeof html !== 'string') return [];
  const m = html.match(/data-page="([^"]*)"/);
  if (!m) return [];
  let page;
  try {
    page = JSON.parse(decodeEntities(m[1]));
  } catch {
    return [];
  }
  const postings = page?.props?.jobPostings;
  if (!Array.isArray(postings)) return [];

  const seen = new Set();
  const jobs = [];
  for (const p of postings) {
    const title = typeof p?.title === 'string' ? p.title.trim() : '';
    const path = typeof p?.url === 'string' ? p.url.trim() : '';
    if (!title || !/^\/companies\/[A-Za-z0-9._~-]+\/jobs\/[^\s?#]+$/.test(path)) continue;
    const url = `${JOBS_ORIGIN}${path}`;
    if (seen.has(url)) continue;
    seen.add(url);
    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = {
      title,
      url,
      company: (typeof p?.companyName === 'string' && p.companyName.trim()) || companyName || '',
      location: typeof p?.location === 'string' ? p.location.trim() : '',
    };
    const ageMs = Number.isFinite(now) ? parseRelativeAgeMs(p?.createdAt) : null;
    if (ageMs !== null) job.postedAt = /** @type {number} */ (now) - ageMs;
    jobs.push(job);
  }
  return jobs;
}
