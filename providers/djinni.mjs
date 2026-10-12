// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Djinni provider — Ukraine's IT job board (https://djinni.co). Postings
// are published by the hiring company or its recruiter (Djinni does not
// distinguish them); candidates read and apply for free. Wire in via a
// `job_boards:` entry; each entry walks one or more of the board's own
// "primary keyword" categories:
//
//   - name: Djinni — DevOps
//     careers_url: https://djinni.co/jobs/
//     searchKeywords: [DevOps, Sysadmin]   # optional, exactly as Djinni names them
//     max_pages: 10                        # optional, default 10, cap 40
//
// `detect()` claims any `https://djinni.co/...` URL (the `/hire` landing page
// included); `provider: djinni` works too. Only the host is read — the path is
// discarded and rebuilt as `/jobs/?primary_keyword={keyword}&page={n}`. With
// no `searchKeywords` the entry reads the newest 150 postings by default
// (10 pages x 15), up to 600 (cap 40 pages) — not the whole board. The category names are the `<category>` list of
// https://djinni.co/jobs/rss/ (`DevOps`, `Sysadmin`, `Python`, `QA`, …).
//
// SOURCE CHECK (measured 2026-10-11, with the scanner's declared User-Agent):
//   - robots.txt, re-checked 2026-10-12 with the scanner's DEFAULT_USER_AGENT:
//     only a `User-agent: *` group exists; no group names ClaudeBot,
//     anthropic-ai, Claude-Web or Claude-User, and there is no Crawl-delay —
//     result: allowed. The `*` group disallows `/jobs2`, `/q`, `/developers`,
//     `/free-jobs` and `/set_lang` — none is requested here;
//   - `/jobs/?primary_keyword=X&page=N` is server-rendered over plain HTTPS,
//     no login, no challenge; every page embeds ONE JSON-LD array of
//     `JobPosting` objects, one per card (15 per page), carrying title, url,
//     hiringOrganization, location, datePosted, the full description and,
//     when the employer published one, a monthly USD salary range;
//   - the RSS feed (`/jobs/rss/`) is lighter but names no employer, which is
//     why the HTML listing is read instead;
//   - postings with no identifiable employer (absent name, or a placeholder
//     such as Confidential) are DROPPED and counted, one warning per fetch;
//   - a short page is the last one; one page past it 302s back to `/jobs/`;
//   - an UNKNOWN keyword is not an error on the site: it silently serves the
//     whole board. The page's `<link rel="canonical">` tells them apart — a
//     known category canonicalizes to `/jobs/keyword-{slug}/`, an unknown one
//     to `/jobs/` — so a typo throws here instead of flooding the pipeline;
//   - an empty category (measured: Blazor) keeps its canonical and renders
//     no JSON-LD and no posting links → [].

import { fetchTextWithRetry, isRefusedRedirectError, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';

const ORIGIN = 'https://djinni.co';
/** The board serves 15 postings per page; a shorter page is the last one. */
const PAGE_SIZE = 15;
const DEFAULT_MAX_PAGES = 10;
/** Hard ceiling on a configured `max_pages` — independent of what the source reports. */
const MAX_PAGES_CAP = 40;
/** Keywords one entry may fan out over (each one costs up to `max_pages` requests). */
const MAX_KEYWORDS = 8;
/** Pause between ANY two requests to the board (pages and keyword passes alike). */
const REQUEST_DELAY_MS = 1000;

const POSTING_PATH_RE = /^\/jobs\/\d+-[^/]+\/?$/;
const ANY_POSTING_LINK_RE = /href=["'](?:https:\/\/djinni\.co)?\/jobs\/\d+-[^/"']+\/?["']/i;
/** What an anonymous posting shows where the employer goes. */
const PLACEHOLDER_EMPLOYER_RE = /^(?:confidential|anonymous|конфіденційно|конфиденциально)(?:\s+(?:company|employer))?[.!]?$/i;
const LD_JSON_RE = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const CANONICAL_RE = /<link\b(?=[^>]*\brel=["']canonical["'])[^>]*\bhref=["']([^"']+)["']/i;

/**
 * Canonical posting URL (https, djinni.co, /jobs/{id}-{slug}/), query and hash
 * stripped; '' when the value is not one.
 * @param {any} raw
 * @returns {string}
 */
export function normalizePostingUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'djinni.co' || !POSTING_PATH_RE.test(u.pathname)) return '';
  return `${ORIGIN}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`;
}

/**
 * True for a `djinni.co` / `www.djinni.co` https URL.
 * @param {any} raw
 * @returns {boolean}
 */
export function isDjinniUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && /^(www\.)?djinni\.co$/i.test(parsed.hostname);
}

/**
 * Keywords to walk, trimmed and deduped (case-insensitively), in config order.
 * An empty list means "the whole board".
 * @param {any} entry
 * @returns {string[]}
 */
export function resolveKeywords(entry) {
  const raw = entry?.searchKeywords;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  /** @type {string[]} */
  const out = [];
  for (const k of list) {
    const kw = typeof k === 'string' ? k.trim() : '';
    if (!kw) {
      throw new Error(`djinni: invalid searchKeywords entry ${JSON.stringify(k)} — expected a Djinni category name such as "DevOps"`);
    }
    if (!out.some(o => o.toLowerCase() === kw.toLowerCase())) out.push(kw);
  }
  if (out.length > MAX_KEYWORDS) {
    throw new Error(`djinni: ${out.length} searchKeywords configured — cap is ${MAX_KEYWORDS} (each one costs up to max_pages requests)`);
  }
  return out;
}

/**
 * Listing URL for one keyword/page. The keyword is config-derived, so it is
 * encoded here (a broken value throws loudly) rather than dropped.
 * @param {string} keyword - '' for the whole board
 * @param {number} page
 * @returns {string}
 */
export function buildListUrl(keyword, page) {
  const params = [];
  if (keyword) params.push(`primary_keyword=${encodeURIComponent(keyword)}`);
  if (page > 1) params.push(`page=${page}`);
  return `${ORIGIN}/jobs/${params.length ? `?${params.join('&')}` : ''}`;
}

/**
 * Epoch ms from a JSON-LD date. Djinni writes local Kyiv time with no offset
 * (`2026-10-10T15:55:42.429344`); it is read as UTC so the result does not
 * depend on the machine's timezone (±3 h is well inside "posted that day").
 * @param {any} value
 * @returns {number | undefined}
 */
export function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const parsed = Date.parse(hasZone ? value : `${value}Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** @param {any} v @returns {string} */
const str = (v) => (typeof v === 'string' ? decodeEntities(v).replace(/\s+/g, ' ').trim() : '');

/**
 * Employer name from `hiringOrganization` (string or `{name}`); '' when absent,
 * blank or a confidentiality placeholder.
 * @param {any} org
 * @returns {string}
 */
export function employerOf(org) {
  const name = str(typeof org === 'string' ? org : org?.name);
  return !name || PLACEHOLDER_EMPLOYER_RE.test(name) ? '' : name;
}

/**
 * Human-readable location: office places from `jobLocation`, then "Remote"
 * (with the applicant region/country, when given) for TELECOMMUTE postings.
 * @param {any} posting
 * @returns {string}
 */
export function locationOf(posting) {
  /** @type {string[]} */
  const parts = [];
  const places = Array.isArray(posting?.jobLocation) ? posting.jobLocation : posting?.jobLocation ? [posting.jobLocation] : [];
  for (const place of places) {
    const addr = place?.address ?? {};
    const localities = (Array.isArray(addr.addressLocality) ? addr.addressLocality : [addr.addressLocality]).map(str).filter(Boolean);
    const country = str(addr.addressCountry);
    const text = [...localities, country].filter(Boolean).join(', ');
    if (text && !parts.includes(text)) parts.push(text);
  }
  if (posting?.jobLocationType === 'TELECOMMUTE') {
    const reqs = Array.isArray(posting.applicantLocationRequirements)
      ? posting.applicantLocationRequirements
      : posting.applicantLocationRequirements ? [posting.applicantLocationRequirements] : [];
    const where = [...new Set(reqs.map(r => str(r?.address?.addressRegion) || str(r?.address?.addressCountry) || str(r?.name)).filter(Boolean))];
    parts.push(where.length ? `Remote (${where.join(', ')})` : 'Remote');
  }
  return parts.join(' · ');
}

/**
 * Annualized salary from a JSON-LD `baseSalary`. Djinni publishes monthly
 * ranges; only MONTH and YEAR units are converted, anything else is omitted.
 * @param {any} baseSalary
 * @returns {{min?: number, max?: number, currency: string} | undefined}
 */
export function salaryOf(baseSalary) {
  const value = baseSalary?.value;
  const unit = typeof value?.unitText === 'string' ? value.unitText.toUpperCase() : '';
  const factor = unit === 'MONTH' ? 12 : unit === 'YEAR' ? 1 : 0;
  if (!factor) return undefined;
  const num = (/** @type {any} */ n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n * factor : undefined);
  const min = num(value.minValue);
  const max = num(value.maxValue);
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    currency: typeof baseSalary.currency === 'string' ? baseSalary.currency.toUpperCase() : '',
  };
}

/**
 * Parse one listing page.
 *
 * @param {string} html
 * @returns {{ jobs: import('./_types.js').Job[], rawCount: number, hasLd: boolean, canonical: string, unattributed: number, badUrls: number }}
 *   `rawCount` is the number of JobPosting objects the SOURCE returned — the
 *   short-page stop reads it, never the filtered count.
 */
export function parseListingPage(html) {
  const source = String(html ?? '');
  /** @type {any[]} */
  let postings = [];
  let hasLd = false;
  LD_JSON_RE.lastIndex = 0;
  let m;
  while ((m = LD_JSON_RE.exec(source)) !== null) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const list = Array.isArray(data) ? data : [data];
    const found = list.filter(o => o && typeof o === 'object' && o['@type'] === 'JobPosting');
    if (found.length) {
      hasLd = true;
      postings = postings.concat(found);
    }
  }

  /** @type {Map<string, import('./_types.js').Job>} */
  const byUrl = new Map();
  let unattributed = 0;
  let badUrls = 0;
  for (const p of postings) {
    const url = normalizePostingUrl(p.url);
    if (!url) {
      badUrls++;
      continue;
    }
    if (byUrl.has(url)) continue;
    const title = str(p.title);
    if (!title) continue;
    const company = employerOf(p.hiringOrganization);
    if (!company) {
      unattributed++;
      continue;
    }
    const description = typeof p.description === 'string' ? htmlToText(p.description) : '';
    const postedAt = toEpochMs(p.datePosted);
    const salary = salaryOf(p.baseSalary);
    const externalId = typeof p.identifier === 'string' || typeof p.identifier === 'number' ? String(p.identifier) : '';
    byUrl.set(url, {
      title,
      url,
      company,
      location: locationOf(p),
      ...(description ? { description } : {}),
      ...(postedAt !== undefined ? { postedAt } : {}),
      ...(salary ? { salary } : {}),
      ...(externalId ? { externalId } : {}),
    });
  }

  const canonical = (CANONICAL_RE.exec(source) ?? [])[1] ?? '';
  return { jobs: [...byUrl.values()], rawCount: postings.length, hasLd, canonical, unattributed, badUrls };
}

/** @type {Provider} */
export default {
  id: 'djinni',

  detect(entry) {
    if (entry?.provider === 'djinni') return { url: `${ORIGIN}/jobs/` };
    return isDjinniUrl(entry?.careers_url) || isDjinniUrl(entry?.api) ? { url: `${ORIGIN}/jobs/` } : null;
  },

  async fetch(entry, ctx) {
    const configured = resolveKeywords(entry);
    /** @type {string[]} */
    let keywords = configured.length ? configured : [''];

    const entryMax = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
      ? Math.min(entry.max_pages, MAX_PAGES_CAP)
      : DEFAULT_MAX_PAGES;
    const ctxMax = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    const probing = Number.isFinite(ctxMax);
    const maxPages = Math.min(entryMax, ctxMax);
    // A health probe reads one page of one keyword.
    if (probing) keywords = keywords.slice(0, 1);

    /** @type {import('./_types.js').Job[]} */
    const jobs = [];
    const seen = new Set();
    let requests = 0;
    /** @type {string[]} */
    const truncated = [];
    let unattributed = 0;
    let badUrls = 0;
    /** @type {string[]} */
    const stops = [];

    for (const keyword of keywords) {
      for (let page = 1; page <= maxPages; page++) {
        if (requests > 0) await sleep(REQUEST_DELAY_MS, ctx);
        requests++;

        const url = buildListUrl(keyword, page);
        let html;
        try {
          html = await fetchTextWithRetry(ctx, url, { redirect: 'error' });
        } catch (err) {
          // One page past the last, the board 302s back to /jobs/: the end of
          // this keyword, not a failure. On page 1 a redirect is a real problem.
          // A challenge redirects too, so the stop is reported, not silent.
          if (page > 1 && !probing && isRefusedRedirectError(err)) {
            stops.push(`${keyword || '(all)'} page ${page}: redirect (end of board, or a challenge)`);
            break;
          }
          throw err;
        }
        const { jobs: parsed, rawCount, hasLd, canonical, unattributed: noEmployer, badUrls: bad } = parseListingPage(html);

        if (!canonical.startsWith(`${ORIGIN}/jobs/`)) {
          if (page === 1) {
            throw new Error(`djinni: ${url} is not a Djinni job listing (no /jobs/ canonical link) — blocked or the page changed`);
          }
          // Mid-walk: keep what was read, but never pass a challenge off as the end.
          stops.push(`${keyword || '(all)'} page ${page}: unrecognised page (no /jobs/ canonical link)`);
          break;
        }
        if (page === 1) {
          if (keyword && canonical === `${ORIGIN}/jobs/`) {
            throw new Error(`djinni: "${keyword}" is not a Djinni category — the board served its unfiltered listing instead. Use a name from https://djinni.co/jobs/rss/ (e.g. "DevOps")`);
          }
        }
        if (rawCount === 0) {
          // Posting links but no JSON-LD: the embedded data moved.
          if (!hasLd && ANY_POSTING_LINK_RE.test(html)) {
            throw new Error(`djinni: ${url} lists postings but carries no JobPosting JSON-LD — the page markup changed`);
          }
          break; // an empty category, or the walk ran dry
        }
        unattributed += noEmployer;
        badUrls += bad;
        if (parsed.length === 0 && noEmployer === 0) {
          throw new Error(`djinni: ${url} returned ${rawCount} JobPosting objects but none carried a valid title and posting URL — the JSON-LD changed`);
        }
        for (const job of parsed) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          jobs.push(job);
        }
        // Short page = the source's own last page (raw count, never the deduped one).
        if (rawCount < PAGE_SIZE) break;
        if (page === maxPages && !probing) truncated.push(keyword || '(all)');
      }
    }

    if (unattributed) {
      console.warn(`djinni: dropped ${unattributed} posting(s) with no identifiable employer (absent or placeholder name)`);
    }
    if (badUrls) {
      console.warn(`djinni: skipped ${badUrls} posting(s) whose url is not a djinni.co /jobs/{id}-{slug}/ link`);
    }
    if (stops.length) {
      console.warn(`djinni: walk ended early, kept what was collected — ${stops.join('; ')}`);
    }
    if (truncated.length) {
      console.warn(entryMax === MAX_PAGES_CAP
        ? `djinni: reached the ${MAX_PAGES_CAP}-page cap for "${truncated.join('", "')}" with more results available — narrow the entry with searchKeywords`
        : `djinni: stopped at max_pages=${maxPages} for "${truncated.join('", "')}" with more results available — raise max_pages on this entry`);
    }
    return jobs;
  },
};
