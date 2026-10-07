// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Games Jobs Direct — games-industry jobs board (all disciplines, worldwide).
// Server-rendered HTML listing, newest first, 10 postings per page:
//   https://www.gamesjobsdirect.com/results?page=N
// Target list: `job_boards:`, selected with `provider: gamesjobsdirect`.
//
// The listing ignores search parameters in the URL, so the whole stream is
// walked page by page and filtered locally. `robots.txt` allows `User-agent: *`
// with `Crawl-Delay: 5`, which this provider honours: 5 s between pages, and
// only as many pages as the recency window needs. Paid "Hot Job" postings are
// pinned to the top of page 1 regardless of date, so a page is judged by its
// NEWEST posting (not its first) when deciding whether to keep paging.
//
// Optional entry fields:
//   maxAgeDays  keep postings from the last N days (default 2; ~100 postings/day)
//   maxPages    hard page cap (default 12, max 30)

import { decodeEntities } from './_html-entities.mjs';
import { sleep } from './_http.mjs';

const ORIGIN = 'https://www.gamesjobsdirect.com';
const PAGE_DELAY_MS = 5_000; // robots.txt Crawl-Delay: 5
const DEFAULT_MAX_AGE_DAYS = 2;
const DEFAULT_MAX_PAGES = 12;
const HARD_MAX_PAGES = 30;

/** @param {unknown} v @param {number} dflt @param {number} max */
function boundedInt(v, dflt, max) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : dflt;
}

/** @type {Provider} */
export default {
  id: 'gamesjobsdirect',

  // Explicit-only: the board's host is not claimed by URL.
  detect(entry) {
    return entry?.provider === 'gamesjobsdirect' ? { url: `${ORIGIN}/results` } : null;
  },

  async fetch(entry, ctx) {
    const maxPages = boundedInt(entry?.maxPages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
    const maxAgeDays = boundedInt(entry?.maxAgeDays, DEFAULT_MAX_AGE_DAYS, 365);
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    // A health probe (verify-portals) asks for one page; honour that.
    const pages = ctx?.maxPages ? Math.min(maxPages, ctx.maxPages) : maxPages;

    const byUrl = new Map();
    for (let page = 1; page <= pages; page++) {
      const html = await ctx.fetchText(`${ORIGIN}/results?page=${page}`, { redirect: 'error' });
      const { jobs, newestMs } = parseGamesJobsDirectPage(html);
      if (jobs.length === 0) break;
      for (const j of jobs) if (!byUrl.has(j.url)) byUrl.set(j.url, j);
      if (newestMs < cutoff) break;
      if (page < pages) await sleep(PAGE_DELAY_MS, ctx);
    }
    return [...byUrl.values()].filter((j) => j.postedAt === undefined || j.postedAt >= cutoff);
  },
};

const text = (/** @type {string} */ s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const field = (/** @type {string} */ card, /** @type {string} */ cls) =>
  text((card.match(new RegExp(`class="${cls}">([^<]*)<`)) || [])[1] || '');

const CARD_RE = /<a href="(\/job\/[^"]+)" class="job-title"[^>]*>([^<]*)<\/a>([\s\S]*?)class="job-posteddate">Posted - (\d{1,2} \w{3} \d{4})/g;

/**
 * Parse one listing page. Exported for unit tests.
 * `newestMs` is the newest `Posted` date on the page (-Infinity when none).
 *
 * @param {string} html
 * @returns {{ jobs: Array<{title: string, url: string, company: string, location: string, postedAt?: number}>, newestMs: number }}
 */
export function parseGamesJobsDirectPage(html) {
  const jobs = [];
  let newestMs = -Infinity;
  if (typeof html !== 'string') return { jobs, newestMs };
  for (const [, href, rawTitle, card, posted] of html.matchAll(CARD_RE)) {
    const title = text(rawTitle);
    if (!title) continue;
    const ms = Date.parse(`${posted} UTC`);
    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = {
      title,
      url: ORIGIN + href,
      company: field(card, 'job-company'),
      location: field(card, 'job-location'),
    };
    if (!Number.isNaN(ms)) {
      job.postedAt = ms;
      newestMs = Math.max(newestMs, ms);
    }
    jobs.push(job);
  }
  return { jobs, newestMs };
}
