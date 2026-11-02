// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// EntertainmentCareers.net provider — a US film/TV/media crew job board
// (job_boards: entry, provider: entertainmentcareers). Real, named employers
// (Hearst Television, Sinclair, Angel Studios, …), server-rendered HTML, no
// login needed to read a listing.
//
// robots.txt (fetched 2026-10-24) disallows `/search/`, `/2/search/` and
// `/psearch/` under `User-agent: *` — the ONLY exception is a comment under a
// separate `User-agent: Googlebot` group ("VIP ACCESS FOR GOOGLE... we keep
// this open for /psearch/"), which does not name this scanner. Those are the
// paths the site's own pagination links point at
// (`/2/search/search2.asp?...&zoom_page=2`). `/jobs/s/{slug}` (page 1 of a
// keyword search) is NOT on that disallow list and serves full results
// server-side. So this provider deliberately fetches ONLY page 1 per keyword
// and never follows the `/2/search/` pagination links — that is rule 6 of the
// Source Indexing Policy applied, not a missing feature.
//
// Each search result card can carry a "Members Only" badge — content gated to
// paid members in the site's own UI even though curl can still read the
// underlying markup. Indexing those would fail Source Indexing Policy rule 1
// ("free for the candidate to read and apply to"), so this provider drops any
// card carrying that badge.
//
// The "Continue To External Site" apply link goes through
// `/jobseeker/jump.asp`, itself disallowed by robots.txt — so `job.url` stays
// the entertainmentcareers.net posting page (the source's own page, per rule 2
// "the source's own page may travel as secondary attribution" when no
// employer URL is reachable without violating robots.txt).
//
// Wire in via a `job_boards:` entry: `provider: entertainmentcareers` plus
// `searchKeywords: [video editor, colorist, editor, post production, ...]`.

import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const ORIGIN = 'https://www.entertainmentcareers.net';
const TRUSTED_HOST = 'www.entertainmentcareers.net';

/** Pacing between successive keyword searches against the same host. */
const INTER_SEARCH_DELAY_MS = 250;

/** @param {string} keyword */
function slugFor(keyword) {
  const slug = String(keyword ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!slug) return null;
  try {
    return encodeURIComponent(slug).replace(/%2F/gi, '-');
  } catch {
    throw new Error(`entertainmentcareers: unencodable searchKeyword: ${JSON.stringify(keyword)}`);
  }
}

/** @param {string} keyword */
export function buildSearchUrl(keyword) {
  const slug = slugFor(keyword);
  if (!slug) throw new Error('entertainmentcareers: empty searchKeyword');
  return `${ORIGIN}/jobs/s/${slug}`;
}

/**
 * Collapse a markup fragment to its visible text.
 * @param {string} fragment
 */
function visibleText(fragment) {
  return decodeEntities(String(fragment ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The location div carries both labels inline — "Market: Portland Location:
 * Portland, ME" — so a leading-prefix strip only removes "Market:" and leaves
 * the second label in the middle of the string. Prefer the text after
 * "Location:" (the real place); fall back to stripping a leading "Market:"
 * when there's no "Location:" label at all.
 * @param {string} text - already passed through visibleText()
 */
function parseLocation(text) {
  const afterLocation = /Location:\s*(.*)$/i.exec(text);
  if (afterLocation) return afterLocation[1].trim();
  return text.replace(/^Market:\s*/i, '').trim();
}

/**
 * Parse a relative "posted" label ("12 hours ago (PT)", "3 days ago") into
 * epoch ms. Unparseable labels (including "NEW" with no "ago" clause) return
 * undefined — the contract documents postedAt as omittable, and guessing a
 * date would be a fabricated claim.
 * @param {string} text
 * @param {number} nowMs
 * @returns {number | undefined}
 */
export function parsePostedAt(text, nowMs = Date.now()) {
  const t = String(text ?? '').toLowerCase();
  const h = /(\d+)\s*hour/.exec(t);
  if (h) return nowMs - Number(h[1]) * 3_600_000;
  const d = /(\d+)\s*day/.exec(t);
  if (d) return nowMs - Number(d[1]) * 86_400_000;
  const w = /(\d+)\s*week/.exec(t);
  if (w) return nowMs - Number(w[1]) * 7 * 86_400_000;
  const mo = /(\d+)\s*month/.exec(t);
  if (mo) return nowMs - Number(mo[1]) * 30 * 86_400_000;
  return undefined;
}

/**
 * Parse one `/jobs/s/{slug}` results page. Exported for unit tests.
 *
 * Cards open at `class="result_title"` (either a `result_block` or
 * `result_altblock` wrapper, alternating for zebra striping — matched on the
 * inner marker, not the wrapper class, so either shape is covered); the
 * window runs to the next such marker. A card carrying a
 * `members-only-badge` span is dropped entirely (see header comment).
 *
 * @param {string} html
 * @returns {{jobs: Array<{title: string, url: string, company: string, location: string, requisitionId?: string, postedAt?: number}>, cardCount: number}}
 */
export function parseSearchPage(html) {
  const source = String(html ?? '');
  const SPLIT_RE = /class=["']result_title["']/gi;

  /** @type {{start: number, end: number}[]} */
  const windows = [];
  let m;
  while ((m = SPLIT_RE.exec(source)) !== null) {
    if (windows.length > 0) windows[windows.length - 1].end = m.index;
    windows.push({ start: m.index, end: source.length });
  }

  const jobs = [];
  for (const win of windows) {
    const card = source.slice(win.start, win.end);
    if (/members-only-badge/i.test(card)) continue; // paywalled-for-candidates — rule 1

    const anchor = /<a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(card);
    if (!anchor) continue;
    let parsed;
    try {
      parsed = new URL(decodeEntities(anchor[1]), ORIGIN);
    } catch {
      continue;
    }
    if (parsed.origin !== ORIGIN) continue; // defense in depth, see icims.mjs precedent
    const title = visibleText(anchor[2]);
    if (!title) continue;

    const company = (/<div\s+class=["']result-company["']>([\s\S]*?)<\/div>/i.exec(card) || [])[1];
    const location = (/<div\s+class=["']result-location["']>([\s\S]*?)<\/div>/i.exec(card) || [])[1];
    const dateline = (/<div\s+class=["']result-dateline["']>([\s\S]*?)<\/div>/i.exec(card) || [])[1];
    const reqId = (/\/job\/(\d+)\/?/.exec(parsed.pathname) || [])[1];
    const postedAt = dateline ? parsePostedAt(visibleText(dateline)) : undefined;

    jobs.push({
      title,
      url: `${parsed.origin}${parsed.pathname}`,
      company: company ? visibleText(company) : '',
      location: location ? parseLocation(visibleText(location)) : '',
      ...(reqId ? { requisitionId: reqId } : {}),
      ...(postedAt !== undefined ? { postedAt } : {}),
    });
  }
  return { jobs, cardCount: windows.length };
}

/**
 * A results page that carries no "N jobs found." summary at all is not the
 * page this provider expects — a markup change, a block page, or a redirect
 * target — and must surface as a failure, not as a quiet empty board.
 * @param {string} html
 */
function summaryCount(html) {
  const m = /<b>(\d+)<\/b>\s*jobs found/i.exec(String(html ?? ''));
  return m ? Number(m[1]) : null;
}

/** @type {Provider} */
export default {
  id: 'entertainmentcareers',

  detect(entry) {
    return entry?.provider === 'entertainmentcareers' ? { url: `${ORIGIN}/jobs/s/editor` } : null;
  },

  async fetch(entry, ctx) {
    const keywords = Array.isArray(entry?.searchKeywords)
      ? entry.searchKeywords.filter((k) => typeof k === 'string' && k.trim())
      : [];
    if (keywords.length === 0) {
      throw new Error('entertainmentcareers: entry needs a non-empty searchKeywords list');
    }
    // verify-portals' health probe sets ctx.maxPages — cap the walk to exactly
    // one request, and let a ctx.fetchText rejection (e.g. ProbePageBudgetReached)
    // propagate unwrapped, per providers/ADDING_A_PROVIDER.md.
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const toFetch = probing ? keywords.slice(0, 1) : keywords;

    const seen = new Set();
    const jobs = [];
    for (let i = 0; i < toFetch.length; i++) {
      if (i > 0) await sleep(INTER_SEARCH_DELAY_MS, ctx);
      const keyword = toFetch[i];
      const url = buildSearchUrl(keyword);
      let html;
      try {
        if (probing) {
          html = await ctx.fetchText(url, { headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT }, redirect: 'error' });
        } else {
          html = await fetchTextWithRetry(ctx, url, { headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT }, redirect: 'error' });
        }
      } catch (err) {
        if (probing) throw err; // never swallow a probe-budget rejection
        continue; // recall-first: one bad keyword doesn't lose the others
      }

      const { jobs: pageJobs, cardCount } = parseSearchPage(html);
      const count = summaryCount(html);
      if (count === null) {
        throw new Error(`entertainmentcareers: ${url} has no "jobs found" summary — page shape changed`);
      }
      if (cardCount === 0 && count > 0) {
        throw new Error(`entertainmentcareers: ${url} reports ${count} jobs found but no cards parsed — markup changed`);
      }
      // count === 0 (and cardCount === 0 to match) is a genuinely empty search — fine.

      for (const job of pageJobs) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push({ ...job, company: job.company || entry?.name || '' });
      }
    }
    return jobs;
  },
};
