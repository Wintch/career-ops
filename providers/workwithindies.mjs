// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Work With Indies — jobs at and with independent game developers. Board-wide
// public RSS feed, no auth:
//   https://www.workwithindies.com/careers/rss.xml
// Target list: `job_boards:`, selected with `provider: workwithindies`.
//
// Titles read "<Company> is hiring a(n) <Role> to work from <Place>", so
// company, role and location come from the title ("Anywhere" when remote with
// no region). `robots.txt` imposes no disallow rules. The feed is a rolling
// window and resurfaces old postings, so items older than `maxAgeDays`
// (entry field, default 10) are dropped.

import { parseRssItems, trustedHttpsUrl } from './_rss.mjs';

const FEED_URL = 'https://www.workwithindies.com/careers/rss.xml';
const HOST = 'workwithindies.com';
const DEFAULT_MAX_AGE_DAYS = 10;
const TITLE_RE = /^(.*?) is hiring an? (.*?) to work from (.*)$/;

/** @type {Provider} */
export default {
  id: 'workwithindies',

  // Explicit-only: the board's host is not claimed by URL.
  detect(entry) {
    return entry?.provider === 'workwithindies' ? { url: FEED_URL } : null;
  },

  async fetch(entry, ctx) {
    const xml = await ctx.fetchText(FEED_URL, { redirect: 'error' });
    return parseWorkWithIndiesFeed(xml, { maxAgeDays: entry?.maxAgeDays, now: Date.now() });
  },
};

/**
 * Parse the Work With Indies feed. Exported for unit tests.
 *
 * @param {string} xml
 * @param {{ maxAgeDays?: unknown, now?: number }} [opts]
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number}>}
 */
export function parseWorkWithIndiesFeed(xml, { maxAgeDays, now = Date.now() } = {}) {
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
      location: m ? m[3].trim() : '',
    };
    if (item.pubDateMs !== undefined) job.postedAt = item.pubDateMs;
    jobs.push(job);
  }
  return jobs;
}
