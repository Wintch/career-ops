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
// Dates: the page only exposes a coarse relative age ("2 months"), which is
// not a reliable timestamp, so `postedAt` is intentionally left unset.
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
    return parseYcJobsPage(html, entry.name);
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
 *   - company:  `companyName` from the posting, else the portal entry name.
 *
 * Rows without a title or a `/companies/` path are dropped (an empty URL would
 * corrupt the URL-based dedup key). A page with no `data-page` payload, or a
 * payload without `jobPostings`, yields [].
 *
 * @param {string} html
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseYcJobsPage(html, companyName) {
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
    jobs.push({
      title,
      url,
      company: (typeof p?.companyName === 'string' && p.companyName.trim()) || companyName || '',
      location: typeof p?.location === 'string' ? p.location.trim() : '',
    });
  }
  return jobs;
}
