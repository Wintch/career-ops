// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Games Workshop careers — single-company adapter for the server-rendered listing
//   https://jobs.games-workshop.com/search-and-apply
// Target list: `tracked_companies:`, auto-detected from a `careers_url` on
// `jobs.games-workshop.com`, or selected with `provider: gamesworkshop`.
//
// The whole board (about 50 postings, retail and head office worldwide) is one page, so one GET
// reads it. robots.txt (measured 2026-10-14): `Crawl-delay: 10`, `User-agent: *` with an empty
// `Disallow:`; there is no group naming ClaudeBot / anthropic-ai / Claude-Web. One request per scan
// stays far under that pace. The page answers 200 to the scanner's declared client.
//
// The page also lists translated copies of some postings under `/es/`, `/de/`, `/ja/`; only the English
// `/search-and-apply/<slug>` pages are kept, so a posting is not counted twice.
//
// Each card carries title, location ("Nottingham, UK") and a "Closes: Nov 4, 2026" line; there is no
// posted date, so none is set. Cards are parsed per chunk (split at each title anchor), so a card
// missing a field cannot swallow its neighbour.
//
// Empty vs broken: posting-shaped links present but zero cards parsed THROWS (markup changed); neither
// present is an empty board.

import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry } from './_http.mjs';

const ORIGIN = 'https://jobs.games-workshop.com';
const LISTING = `${ORIGIN}/search-and-apply`;
const COMPANY = 'Games Workshop';

const text = (/** @type {string} */ s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/[\s ]+/g, ' ').trim();
const TITLE_RE = /<div class="jobs-listing__list__item__title">\s*<a href="([^"]+)">([\s\S]*?)<\/a>/g;
const field = (/** @type {string} */ chunk, /** @type {string} */ name) => {
  const m = chunk.match(new RegExp(`jobs-listing__list__item__${name}">([\\s\\S]*?)</div>`));
  return m ? text(m[1]) : '';
};

/** @type {Provider} */
export default {
  id: 'gamesworkshop',

  detect(entry) {
    if (entry?.provider === 'gamesworkshop') return { url: LISTING };
    try {
      return new URL(String(entry?.careers_url || '')).hostname === 'jobs.games-workshop.com' ? { url: LISTING } : null;
    } catch {
      return null;
    }
  },

  async fetch(_entry, ctx) {
    const html = await fetchTextWithRetry(ctx, LISTING, { redirect: 'error' });
    return parseGamesWorkshopListing(html);
  },
};

/**
 * Parse the listing page. Exported for unit tests.
 *
 * @param {string} html
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseGamesWorkshopListing(html) {
  if (typeof html !== 'string') return [];
  const anchors = [...html.matchAll(TITLE_RE)];
  const jobs = [];
  anchors.forEach((a, i) => {
    const start = (a.index ?? 0) + a[0].length;
    const chunk = html.slice(start, i + 1 < anchors.length ? anchors[i + 1].index : html.length);
    let url;
    try {
      const u = new URL(decodeEntities(a[1]), ORIGIN);
      if (u.origin !== ORIGIN || !u.pathname.startsWith('/search-and-apply/')) return;
      url = u.href;
    } catch {
      return;
    }
    const title = text(a[2]);
    if (!title) return;
    jobs.push({ title, url, company: COMPANY, location: field(chunk, 'location') });
  });
  if (jobs.length === 0 && html.includes('/search-and-apply/') && html.includes('jobs-listing__list__item')) {
    throw new Error('gamesworkshop: listing has job items but no cards parsed (markup changed)');
  }
  return jobs;
}
