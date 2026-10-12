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
// robots.txt (measured 2026-10-12 with the scanner's DEFAULT_USER_AGENT):
// `User-agent: *` is `Allow: /` with `Crawl-Delay: 5`. Named groups disallow
// everything for Jobbot/JobBot, barkrowler, dotbot/DotBot, Yandex, AwarioRssBot,
// AwarioSmartBot, BLEXBot, ZoominfoBot, rogerbot, AccompanyBot, Adsbot and
// SeznamBot; there is NO group naming ClaudeBot, anthropic-ai, Claude-Web or
// Claude-User, so the `*` group applies.
//
// Empty vs broken: on page 1, a page that still carries `href="/job/` links but
// parses to zero cards THROWS (markup changed); a silent stop is only for later
// pages or a page with no /job/ links. Cards are parsed per chunk (split at each
// job-title anchor), so a card missing a field can never swallow its neighbour.
// Cards with no identifiable employer are dropped and counted in one
// console.warn per fetch. Pages go through fetchTextWithRetry; a failure on
// page 2..N keeps the pages already read (with a console.warn), page 1 throws.
//
// Exhaustion policy: paging stops at the first page whose newest posting is
// older than the window, or at `maxPages`. Ending on the page budget while the
// last page is still inside the window logs "stopped at max_pages ... raise
// maxPages" rather than ending silently.
//
// Optional entry fields:
//   maxAgeDays  keep postings from the last N days (alias since_days; default 2;
//               ~100 postings/day). The cutoff is UTC midnight of today - N days.
//   maxPages    page cap (alias max_pages; default 25, max 30)

import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry, sleep } from './_http.mjs';
import { isUnattributed } from './_rss.mjs';

const ORIGIN = 'https://www.gamesjobsdirect.com';
const PAGE_DELAY_MS = 5_000; // robots.txt Crawl-Delay: 5
const DEFAULT_MAX_AGE_DAYS = 2;
const DEFAULT_MAX_PAGES = 25;
const HARD_MAX_PAGES = 30;
const DAY_MS = 86_400_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

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
    const maxPages = boundedInt(entry?.maxPages ?? entry?.max_pages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
    const maxAgeDays = boundedInt(entry?.maxAgeDays ?? entry?.since_days, DEFAULT_MAX_AGE_DAYS, 365);
    // `ctx.now` (ms) is a test hook; production reads the wall clock.
    const now = typeof ctx?.now === 'number' ? ctx.now : Date.now();
    const d = new Date(now);
    const cutoff = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - maxAgeDays * DAY_MS;
    // A health probe (verify-portals) asks for one page; honour that.
    const probe = Boolean(ctx?.maxPages) && ctx.maxPages < maxPages;
    const pages = probe ? ctx.maxPages : maxPages;

    const byUrl = new Map();
    let dropped = 0;
    let endedOnBudget = false;
    for (let page = 1; page <= pages; page++) {
      let html;
      try {
        html = await fetchTextWithRetry(ctx, `${ORIGIN}/results?page=${page}`, { redirect: 'error' });
      } catch (err) {
        if (page === 1) throw err;
        console.warn(`gamesjobsdirect: page ${page} failed (${err?.message || err}); keeping ${byUrl.size} posting(s) from earlier pages`);
        break;
      }
      const { jobs, newestMs, dropped: pageDropped } = parseGamesJobsDirectPage(html);
      dropped += pageDropped;
      if (jobs.length === 0 && pageDropped === 0) {
        if (page === 1 && typeof html === 'string' && html.includes('href="/job/')) {
          throw new Error('gamesjobsdirect: page 1 has /job/ links but no cards parsed (markup changed)');
        }
        break;
      }
      for (const j of jobs) if (!byUrl.has(j.url)) byUrl.set(j.url, j);
      if (newestMs < cutoff) break;
      if (page === pages) { endedOnBudget = !probe; break; }
      await sleep(PAGE_DELAY_MS, ctx);
    }
    if (endedOnBudget) {
      console.warn(`gamesjobsdirect: stopped at max_pages (${pages}) with the last page still inside the ${maxAgeDays}-day window; raise maxPages`);
    }
    if (dropped) console.warn(`gamesjobsdirect: dropped ${dropped} posting(s) with no identifiable employer`);
    return [...byUrl.values()].filter((j) => j.postedAt === undefined || j.postedAt >= cutoff);
  },
};

const text = (/** @type {string} */ s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const field = (/** @type {string} */ chunk, /** @type {string} */ cls) => {
  const m = chunk.match(new RegExp(`<(\\w+)\\b(?:[^>"]|"[^"]*")*?class="[^"]*\\b${cls}\\b[^"]*"(?:[^>"]|"[^"]*")*>([\\s\\S]*?)</\\1>`));
  return m ? text(m[2]) : '';
};

// Any anchor; attribute values may contain '>' so they are matched quote-aware.
const ANCHOR_RE = /<a\b((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/a>/g;
const DATE_RE = /class="[^"]*\bjob-posteddate\b[^"]*"[^>]*>\s*Posted\s*-\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/;

/** @param {string} d @param {string} mon @param {string} y */
function parseDate(d, mon, y) {
  const m = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
  return m < 0 ? NaN : Date.UTC(Number(y), m, Number(d));
}

/**
 * Parse one listing page. Exported for unit tests.
 * `newestMs` is the newest `Posted` date on the page (-Infinity when none);
 * `dropped` counts cards skipped for having no identifiable employer.
 *
 * @param {string} html
 * @returns {{ jobs: Array<{title: string, url: string, company: string, location: string, postedAt?: number}>, newestMs: number, dropped: number }}
 */
export function parseGamesJobsDirectPage(html) {
  const jobs = [];
  let newestMs = -Infinity;
  let dropped = 0;
  if (typeof html !== 'string') return { jobs, newestMs, dropped };
  /** @type {Array<{start: number, end: number, href: string, title: string}>} */
  const anchors = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    const attrs = m[1];
    const href = (attrs.match(/\bhref="(\/job\/[^"]*)"/) || [])[1];
    const cls = (attrs.match(/\bclass="([^"]*)"/) || [])[1] || '';
    if (!href || !/\bjob-title\b/.test(cls)) continue;
    anchors.push({ start: m.index, end: m.index + m[0].length, href, title: text(m[2]) });
  }
  anchors.forEach((a, i) => {
    const chunk = html.slice(a.end, i + 1 < anchors.length ? anchors[i + 1].start : html.length);
    const dm = chunk.match(DATE_RE);
    const ms = dm ? parseDate(dm[1], dm[2], dm[3]) : NaN;
    if (!Number.isNaN(ms)) newestMs = Math.max(newestMs, ms);
    if (!a.title) return;
    let url;
    try {
      const u = new URL(decodeEntities(a.href), ORIGIN);
      if (u.origin !== ORIGIN) return;
      url = u.href;
    } catch {
      return;
    }
    const company = field(chunk, 'job-company');
    if (isUnattributed(company)) { dropped++; return; }
    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = { title: a.title, url, company, location: field(chunk, 'job-location') };
    if (!Number.isNaN(ms)) job.postedAt = ms;
    jobs.push(job);
  });
  return { jobs, newestMs, dropped };
}
