// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Work With Indies — jobs at and with independent game developers. Board-wide
// public RSS feed, no auth:
//   https://www.workwithindies.com/careers/rss.xml
// Target list: `job_boards:`, selected with `provider: workwithindies`.
//
// Titles read "<Company> is hiring a(n) <Role> to work from <Place>", so
// company, role and location come from the title ("Anywhere" when remote with
// no region). The feed is a rolling window and resurfaces old postings, so
// items older than `maxAgeDays` (entry field, alias `since_days`, default 10)
// are dropped.
//
// robots.txt (measured 2026-10-12 with the scanner's DEFAULT_USER_AGENT): the
// file holds only a Sitemap line, no rules and no groups (checked: *,
// ClaudeBot, anthropic-ai, Claude-Web, Claude-User), so everything is allowed.
//
// Empty vs broken: a body that is not RSS, or a feed whose <item> blocks yield
// no rows, THROWS (see _rss.mjs); [] means a well-formed channel with no items.
// Items with no identifiable employer (title off-pattern, or a placeholder
// such as "Confidential") are dropped and counted in one console.warn per
// fetch. Links must sit under /careers/ on the default port. Single request,
// so there is no page budget to exhaust.

import { parseRssItems, trustedHttpsUrl, isUnattributed } from './_rss.mjs';

const FEED_URL = 'https://www.workwithindies.com/careers/rss.xml';
const HOST = 'workwithindies.com';
const DEFAULT_MAX_AGE_DAYS = 10;
const TITLE_RE = /^(.*?) is hiring (?:an? )?(.*?) to work from (.*)$/i;

/** @type {Provider} */
export default {
  id: 'workwithindies',

  // Explicit-only: the board's host is not claimed by URL.
  detect(entry) {
    return entry?.provider === 'workwithindies' ? { url: FEED_URL } : null;
  },

  async fetch(entry, ctx) {
    const xml = await ctx.fetchText(FEED_URL, { redirect: 'error' });
    return parseWorkWithIndiesFeed(xml, { maxAgeDays: entry?.maxAgeDays ?? entry?.since_days, now: Date.now() });
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
  let dropped = 0;
  for (const item of parseRssItems(xml)) {
    const url = trustedHttpsUrl(item.link, HOST, '/careers/');
    if (!url || !item.title || seen.has(url)) continue;
    if (item.pubDateMs !== undefined && item.pubDateMs < cutoff) continue;
    const m = item.title.match(TITLE_RE);
    if (!m || isUnattributed(m[1])) { dropped++; continue; }
    seen.add(url);
    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}} */
    const job = {
      title: m[2].trim(),
      url,
      company: m[1].trim(),
      location: m[3].trim(),
    };
    if (item.pubDateMs !== undefined) job.postedAt = item.pubDateMs;
    jobs.push(job);
  }
  if (dropped) console.warn(`workwithindies: dropped ${dropped} item(s) with no identifiable employer`);
  return jobs;
}
