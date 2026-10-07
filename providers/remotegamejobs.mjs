// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Remote Game Jobs — remote roles in the games industry (programming, art,
// design, production). Board-wide public RSS feed, no auth:
//   https://remotegamejobs.com/feed.rss
// Target list: `job_boards:`, selected with `provider: remotegamejobs`.
//
// Titles read "<Company> is hiring <Role> (Remote Job)", so company and role
// are split from the title. The feed names no region, so `location` is
// "Remote". `robots.txt` disallows only /goto/ (the outbound redirector);
// feed items link to /jobs/<slug>, which is what this provider emits.
//
// The feed is a rolling window of recent postings, so use it to notice new
// openings. Optional entry field `maxAgeDays` (default 10) drops older items.

import { parseRssItems, trustedHttpsUrl } from './_rss.mjs';

const FEED_URL = 'https://remotegamejobs.com/feed.rss';
const HOST = 'remotegamejobs.com';
const DEFAULT_MAX_AGE_DAYS = 10;
const TITLE_RE = /^(.*?) is hiring (.*?)\s*\(Remote Job\)\s*$/;

/** @type {Provider} */
export default {
  id: 'remotegamejobs',

  // Explicit-only: the board's host is not claimed by URL.
  detect(entry) {
    return entry?.provider === 'remotegamejobs' ? { url: FEED_URL } : null;
  },

  async fetch(entry, ctx) {
    // redirect:'error' keeps the request pinned to the feed host.
    const xml = await ctx.fetchText(FEED_URL, { redirect: 'error' });
    return parseRemoteGameJobsFeed(xml, { maxAgeDays: entry?.maxAgeDays, now: Date.now() });
  },
};

/**
 * Parse the Remote Game Jobs feed. Exported for unit tests.
 *
 * @param {string} xml
 * @param {{ maxAgeDays?: unknown, now?: number }} [opts] `now` makes the age cut deterministic.
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseRemoteGameJobsFeed(xml, { maxAgeDays, now = Date.now() } = {}) {
  const days = Number(maxAgeDays);
  const cutoff = now - (Number.isFinite(days) && days > 0 ? days : DEFAULT_MAX_AGE_DAYS) * 86_400_000;
  const seen = new Set();
  const jobs = [];
  for (const item of parseRssItems(xml)) {
    const url = trustedHttpsUrl(item.link, HOST);
    if (!url || !item.title || seen.has(url)) continue;
    if (item.pubDateMs !== undefined && item.pubDateMs < cutoff) continue;
    seen.add(url);
    const m = item.title.match(TITLE_RE);
    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = {
      title: m ? m[2].trim() : item.title,
      url,
      company: m ? m[1].trim() : '',
      location: 'Remote',
    };
    if (item.pubDateMs !== undefined) job.postedAt = item.pubDateMs;
    jobs.push(job);
  }
  return jobs;
}
